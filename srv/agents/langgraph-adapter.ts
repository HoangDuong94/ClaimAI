import { loadMcpTools } from '@langchain/mcp-adapters';
import { createReactAgent } from '@langchain/langgraph/prebuilt';
import { AzureOpenAiChatClient } from '@sap-ai-sdk/langchain';
import { MemorySaver } from '@langchain/langgraph-checkpoint';
import { DynamicStructuredTool } from '@langchain/core/tools';
import type { StructuredToolInterface } from '@langchain/core/tools';
import * as z from 'zod';
import MarkdownConverter from '../utils/markdown-converter.js';
import { jsonSchemaToZod } from '../m365-mcp/mcp-jsonschema.js';
import type { initAllMCPClients } from '../lib/mcp-client.js';
import type { AgentAdapter, AgentCallOptions } from './agent-adapter.js';

const isTruthy = (value: string | undefined): boolean => {
  if (!value) return false;
  switch (value.toLowerCase().trim()) {
    case '1':
    case 'true':
    case 'yes':
    case 'on':
      return true;
    default:
      return false;
  }
};

type MCPClients = Awaited<ReturnType<typeof initAllMCPClients>>;
type AgentExecutor = ReturnType<typeof createReactAgent>;

interface LangGraphAdapterDependencies {
  ensureMcpClients: () => Promise<MCPClients>;
  langGraphSystemPrompt: string;
  logger?: Console;
}

export class LangGraphAgentAdapter implements AgentAdapter {
  private readonly ensureMcpClients: () => Promise<MCPClients>;
  private readonly langGraphSystemPrompt: string;
  private readonly logger: Console;
  private agentExecutor: AgentExecutor | null = null;
  private langSmithStateLogged = false;

  constructor(deps: LangGraphAdapterDependencies) {
    this.ensureMcpClients = deps.ensureMcpClients;
    this.langGraphSystemPrompt = deps.langGraphSystemPrompt;
    this.logger = deps.logger ?? console;
  }

  async warmup(): Promise<void> {
    await this.ensureAgentExecutor();
  }

  async call(options: AgentCallOptions): Promise<string> {
    const { prompt, capContext, userId } = options;
    if (!capContext) {
      throw new Error('capContext is required for LangGraph agent execution.');
    }

    const executor = await this.ensureAgentExecutor();
    const clients = await this.ensureMcpClients();

    return await clients.cap.runWithContext(capContext, async () => {
      const systemMessage = {
        role: 'system',
        content: this.langGraphSystemPrompt,
      };

      const userMessage = {
        role: 'user',
        content: prompt,
      };

      const stream = await executor.stream(
        {
          messages: [systemMessage, userMessage],
        },
        {
          configurable: { thread_id: `session_${userId || 'default'}` },
        },
      );

      const finalResponseParts: string[] = [];
      this.logger.log('\n\n---- AGENT STREAM START ----\n');

      for await (const chunk of stream) {
        if (chunk.agent?.messages) {
          const message = chunk.agent.messages[chunk.agent.messages.length - 1];
          if (message && message.content) {
            process.stdout.write(message.content);
            finalResponseParts.push(message.content);
          }
          if (message.tool_calls && message.tool_calls.length > 0) {
            const toolCall = message.tool_calls[0];
            const toolCallStr = `

<TOOL_CALL>
  Tool: ${toolCall.name}
  Args: ${JSON.stringify(toolCall.args)}
</TOOL_CALL>

`;
            process.stdout.write(toolCallStr);
          }
        }

        if (chunk.tools?.messages) {
          const toolMessage = chunk.tools.messages[0];
          const toolOutputStr = `<TOOL_OUTPUT>
  ${toolMessage.content}
</TOOL_OUTPUT>

`;
          process.stdout.write(toolOutputStr);
        }
      }
      this.logger.log('\n---- AGENT STREAM END ----\n');

      const rawResponse = finalResponseParts.join('');
      return MarkdownConverter.convertForClaims(rawResponse);
    });
  }

  private async ensureAgentExecutor(): Promise<AgentExecutor> {
    if (this.agentExecutor) {
      return this.agentExecutor;
    }

    this.logLangSmithState();
    this.logger.log(
      'Initializing Agent with CAP data access, Web Search, Filesystem, Excel, Microsoft 365, and Time capabilities...',
    );

    const clients = await this.ensureMcpClients();

    try {
      const [capTools, cdsModelTools, braveSearchTools, filesystemTools, excelTools, timeTools] =
        await Promise.all([
          loadMcpTools('cap', clients.cap),
          loadMcpTools('search_model', clients.cdsModel),
          loadMcpTools('brave_web_search,brave_local_search', clients.braveSearch),
          loadMcpTools(
            'read_file,write_file,edit_file,create_directory,list_directory,move_file,search_files,get_file_info,list_allowed_directories',
            clients.filesystem,
          ),
          loadMcpTools(
            'excel_describe_sheets,excel_read_sheet,excel_screen_capture,excel_write_to_sheet,excel_create_table,excel_copy_sheet',
            clients.excel,
          ),
          loadMcpTools('get_current_time,convert_time', clients.time),
        ]) as StructuredToolInterface[][];

      const postgresTools: StructuredToolInterface[] = [];
      const allTools = [
        ...postgresTools,
        ...cdsModelTools,
        ...capTools,
        ...braveSearchTools,
        ...filesystemTools,
        ...excelTools,
        ...timeTools,
      ];

      if (clients.m365) {
        this.logger.log('Loading Microsoft 365 tools...');
        const manifest = await clients.m365.listTools();
        const m365Tools = manifest.tools.map((toolDef) => {
          const schema = jsonSchemaToZod(toolDef.inputSchema, z);
          return new DynamicStructuredTool({
            name: toolDef.name,
            description: toolDef.description,
            schema,
            func: async (input) => {
              const result = await clients.m365!.callTool({ name: toolDef.name, arguments: input });
              return typeof result === 'string' ? result : JSON.stringify(result);
            },
          });
        });
        allTools.push(...m365Tools);
        this.logger.log(`✅ Loaded ${m365Tools.length} Microsoft 365 tools`);
      }

      if (clients.cap) {
        const triageToolSchema = z.object({
          folder: z.string().optional().describe('Mailordner (Standard: inbox).'),
          messageId: z.string().optional().describe('Optional: Konkrete Nachricht ID statt neuester Nachricht.')
        });
        const mailTriageTool = new DynamicStructuredTool({
          name: 'cap_mail_triage_latest',
          description: 'Führt die ClaimAI Mail-Triage aus (Zusammenfassung, Kategorie und Anhangs-Insights).',
          schema: triageToolSchema,
          func: async (input) => {
            const result = await clients.cap.callTool({
              name: 'cap.mail.triageLatest',
              arguments: input
            });
            return typeof result === 'string' ? result : JSON.stringify(result);
          }
        });
        allTools.push(mailTriageTool);
      }

      this.logger.log(
        `✅ Loaded ${capTools.length} CAP, ${cdsModelTools.length} cds-mcp, ${braveSearchTools.length} Brave Search, ${filesystemTools.length} Filesystem, ${excelTools.length} Excel, and ${timeTools.length} Time tools (${postgresTools.length} PostgreSQL tools currently disabled)`,
      );
      this.logger.log('Available tools:', allTools.map((tool) => tool.name));

      const llm = new AzureOpenAiChatClient({ modelName: 'gpt-4.1' });
      const checkpointer = new MemorySaver();

      this.agentExecutor = createReactAgent({
        llm,
        tools: allTools,
        checkpointSaver: checkpointer,
      });

      this.logger.log(
        '✅ Multi-Modal Agent is ready (Database + Web Search + Filesystem + Excel + M365 + Time).',
      );
      return this.agentExecutor;
    } catch (error) {
      this.logger.error?.('❌ Failed to initialize agent:', error);
      throw error;
    }
  }

  private logLangSmithState(): void {
    if (this.langSmithStateLogged) return;
    this.langSmithStateLogged = true;

    const tracingEnabled =
      isTruthy(process.env.LANGSMITH_TRACING) || isTruthy(process.env.LANGCHAIN_TRACING_V2);
    const project =
      process.env.LANGSMITH_PROJECT ||
      process.env.LANGCHAIN_PROJECT ||
      process.env.LANGSMITH_DEFAULT_PROJECT;

    if (tracingEnabled) {
      const projectSuffix = project ? ` (project: ${project})` : '';
      this.logger.log(`LangSmith tracing enabled${projectSuffix}.`);
    } else {
      this.logger.log(
        'LangSmith tracing disabled. Set LANGSMITH_TRACING=true to emit traces to smith.langchain.com.',
      );
    }
  }
}
