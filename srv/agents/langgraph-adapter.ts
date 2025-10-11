import { loadMcpTools } from '@langchain/mcp-adapters';
import { createReactAgent } from '@langchain/langgraph/prebuilt';
import { StateGraph, MessagesAnnotation, Command, START } from '@langchain/langgraph';
import { AzureOpenAiChatClient } from '@sap-ai-sdk/langchain';
import { MemorySaver } from '@langchain/langgraph-checkpoint';
import { DynamicStructuredTool } from '@langchain/core/tools';
import type { StructuredToolInterface } from '@langchain/core/tools';
import type { RunnableConfig } from '@langchain/core/runnables';
import type { BaseMessage } from '@langchain/core/messages';
import { AIMessage, SystemMessage, isAIMessage } from '@langchain/core/messages';
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

const extractMessageText = (message: BaseMessage | undefined): string => {
  if (!message) return '';
  const { content } = message;
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (!part) return '';
        if (typeof part === 'string') return part;
        if (typeof part === 'object' && 'text' in part && typeof part.text === 'string') {
          return part.text;
        }
        return '';
      })
      .join(' ');
  }
  if (typeof content === 'object' && content !== null && 'text' in content) {
    const text = (content as { text?: unknown }).text;
    return typeof text === 'string' ? text : '';
  }
  return '';
};

const CLAIMS_KEYWORDS = [/schadenf[aä]ll/i, /claims?/i];
const CLAIMS_CONTEXT_HINTS = [/liste/i, /welche/i, /zeige?|zeig/i, /anzahl/i, /habe?n?/i];
const ROUTER_NEGATIVE_HINTS = [/neuer chat/i, /reset/i];

const isClaimsDataIntent = (text: string): boolean => {
  const normalized = text.trim();
  if (!normalized) return false;
  if (ROUTER_NEGATIVE_HINTS.some((regex) => regex.test(normalized))) {
    return false;
  }
  const matchesKeyword = CLAIMS_KEYWORDS.some((regex) => regex.test(normalized));
  if (!matchesKeyword) {
    return false;
  }
  return CLAIMS_CONTEXT_HINTS.some((regex) => regex.test(normalized));
};

const stableStringify = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a.localeCompare(b),
    );
    return `{${entries.map(([key, val]) => `${JSON.stringify(key)}:${stableStringify(val)}`).join(',')}}`;
  }
  return JSON.stringify(value);
};

const formatCurrency = (value: unknown): string => {
  const numeric = typeof value === 'number' ? value : Number(value ?? 0);
  if (Number.isNaN(numeric)) {
    return 'k. A.';
  }
  return new Intl.NumberFormat('de-CH', {
    style: 'currency',
    currency: 'CHF',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(numeric);
};

const formatDate = (value: unknown): string => {
  if (typeof value !== 'string') return 'k. A.';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return 'k. A.';
  return new Intl.DateTimeFormat('de-CH', { dateStyle: 'medium' }).format(parsed);
};

interface ClaimsRowLike {
  claim_number?: string;
  status?: string;
  incident_date?: string;
  estimated_cost?: unknown;
  severity_score?: unknown;
  fraud_score?: unknown;
  claimant_name?: string;
}

const buildClaimsSummary = (rows: ClaimsRowLike[], limit: number): string => {
  if (!Array.isArray(rows) || rows.length === 0) {
    return 'Keine Schadenfälle gefunden.';
  }
  const limited = rows.slice(0, limit);
  const lines = limited.map((row, index) => {
    const rank = `${index + 1}.`;
    const claimNumber = row.claim_number || 'Unbekannte Nummer';
    const status = row.status || 'Status unbekannt';
    const claimant = row.claimant_name || 'Unbekannter Anspruchsteller';
    const incidentDate = formatDate(row.incident_date);
    const cost = formatCurrency(row.estimated_cost);
    const severity =
      row.severity_score === null || row.severity_score === undefined ? '–' : String(row.severity_score);
    const fraud =
      row.fraud_score === null || row.fraud_score === undefined ? '–' : String(row.fraud_score);
    return `${rank} **${claimNumber}** — ${status}; ${incidentDate}; Kosten ${cost}; Severity ${severity}/100; Fraud ${fraud}/100; Anspruchsteller: ${claimant}`;
  });
  const moreIndicator = rows.length > limited.length ? ` (gezeigt: ${limited.length} von ${rows.length})` : '';
  return [`**Schadenfälle${moreIndicator}:**`, ...lines].join('\n');
};

interface ToolContentLike {
  type?: string;
  text?: unknown;
}

const stringifyToolResult = (value: unknown): string => {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';

  if (typeof value === 'object' && value !== null) {
    const asRecord = value as Record<string, unknown>;

    const directText = asRecord.text;
    if (typeof directText === 'string') {
      return directText;
    }

    const content = asRecord.content;
    if (Array.isArray(content)) {
      const textParts = content
        .map((item) => {
          if (!item || typeof item !== 'object') return '';
          const entry = item as ToolContentLike;
          return typeof entry.text === 'string' ? entry.text : '';
        })
        .filter((part) => part.length > 0);

      if (textParts.length) {
        return textParts.join('\n');
      }
    }
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
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
  private readonly cdsMetadataCache = new Map<string, string>();
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
    const { prompt, capContext, userId, conversationId } = options;
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

      this.logger.log('\n\n---- AGENT INVOKE START ----\n');

      const conversationKey =
        typeof conversationId === 'string' && conversationId.trim().length
          ? conversationId.trim()
          : `session_${userId || 'default'}`;
      const threadId = `${conversationKey}_${Date.now()}`;

      const result = await executor.invoke(
        {
          messages: [systemMessage, userMessage],
        },
        {
          configurable: {
            thread_id: threadId,
            conversation_id: conversationId,
          },
        },
      );

      const messages = Array.isArray(result.messages) ? (result.messages as BaseMessage[]) : [];
      const aiMessages = messages.filter((message) => message.getType?.() === 'ai');
      const aiTexts = aiMessages
        .map((message) => extractMessageText(message))
        .filter((text) => text.trim().length > 0);
      const finalText =
        aiTexts[aiTexts.length - 1] ||
        extractMessageText(messages[messages.length - 1] as BaseMessage | undefined) ||
        '';

      this.logger.log('Agent messages:', aiTexts);
      this.logger.log('\n---- AGENT INVOKE END ----\n');

      if (!finalText) {
        return MarkdownConverter.convertForClaims('Keine Antwort verfügbar.');
      }

      return MarkdownConverter.convertForClaims(finalText);
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
      const [
        capTools,
        rawCdsModelTools,
        braveSearchTools,
        filesystemTools,
        excelTools,
        timeTools,
      ] = (await Promise.all([
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
      ])) as StructuredToolInterface[][];

      const searchModelDescription = rawCdsModelTools[0]?.description ??
        'Suche CAP Artefakte anhand ihres Namens oder einer Teilzeichenfolge.';
      const searchModelSchema = z
        .object({
          projectPath: z.string().trim().optional(),
          name: z.string().trim().min(1, 'Name des Artefakts ist erforderlich.'),
        })
        .passthrough();

      const cachedSearchModelTool = new DynamicStructuredTool({
        name: 'search_model',
        description: `${searchModelDescription} (mit Ergebnis-Cache pro Sitzung).`,
        schema: searchModelSchema,
        func: async (input) => {
          const payload = { ...input } as Record<string, unknown>;
          if (!payload.projectPath) {
            payload.projectPath = '.';
          }
          const cacheKey = stableStringify(payload);
          const cached = this.cdsMetadataCache.get(cacheKey);
          if (cached) {
            this.logger.debug?.('search_model cache hit for', payload.name);
            return cached;
          }
          this.logger.debug?.('search_model cache miss for', payload.name);
          const result = await clients.cdsModel.callTool({ name: 'search_model', arguments: payload });
          const serialized = stringifyToolResult(result);
          this.cdsMetadataCache.set(cacheKey, serialized);
          return serialized;
        },
      });

      const claimsSummaryColumns = [
        'claim_number',
        'status',
        'incident_date',
        'estimated_cost',
        'severity_score',
        'fraud_score',
        'claimant_name',
      ];

      const claimsListSummaryTool = new DynamicStructuredTool({
        name: 'cap.claims.list_summary',
        description:
          'Liest ClaimsService.Claims und liefert eine kompakte Markdown-Zusammenfassung der wichtigsten Felder (max. 20 Einträge).',
        schema: z
          .object({
            limit: z
              .number()
              .int()
              .min(1)
              .max(20)
              .optional()
              .describe('Maximale Anzahl der anzuzeigenden Schadenfälle (Standard: 5).'),
          })
          .passthrough(),
        func: async (input) => {
          const limit = Math.min(Math.max(input?.limit ?? 5, 1), 20);
          const baseArguments = {
            entity: 'ClaimsService.Claims',
            columns: claimsSummaryColumns,
            limit,
          };
          const mergedArguments = {
            ...baseArguments,
            draft: 'merged',
          };

          const execute = async (args: Record<string, unknown>) => {
            const toolResult = await clients.cap.callTool({
              name: 'cap.cqn.read',
              arguments: args,
            });
            const serialized = stringifyToolResult(toolResult);
            let parsed: unknown;
            try {
              parsed = JSON.parse(serialized);
            } catch (error) {
              this.logger.error?.('cap.claims.list_summary JSON parse failed:', error);
              return [] as ClaimsRowLike[];
            }
            const rows = Array.isArray((parsed as { rows?: unknown }).rows)
              ? ((parsed as { rows: ClaimsRowLike[] }).rows)
              : [];
            return rows;
          };

          let rows = await execute(mergedArguments);

          if (!rows.length) {
            this.logger.debug?.('cap.claims.list_summary fallback: requesting draft rows');
            const draftOnlyArguments = {
              ...baseArguments,
              where: [
                { ref: ['IsActiveEntity'] },
                '=',
                { val: false },
              ],
            } as Record<string, unknown>;
            rows = await execute(draftOnlyArguments);
          }

          if (!rows.length) {
            return 'Keine Schadenfälle gefunden.';
          }

          return buildClaimsSummary(rows, limit);
        },
      });

      const cdsModelTools: StructuredToolInterface[] = [cachedSearchModelTool];
      const postgresTools: StructuredToolInterface[] = [];
      const allTools: StructuredToolInterface[] = [
        ...postgresTools,
        ...cdsModelTools,
        ...capTools,
        claimsListSummaryTool,
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

      let mailTriageTool: StructuredToolInterface | null = null;
      if (clients.cap) {
        const triageToolSchema = z.object({
          folder: z.string().optional().describe('Mailordner (Standard: inbox).'),
          messageId: z
            .string()
            .optional()
            .describe('Optional: Konkrete Nachricht ID statt neuester Nachricht.'),
        });
        mailTriageTool = new DynamicStructuredTool({
          name: 'cap_mail_triage_latest',
          description: 'Führt die ClaimAI Mail-Triage aus (Zusammenfassung, Kategorie und Anhangs-Insights).',
          schema: triageToolSchema,
          func: async (input) => {
            const result = await clients.cap.callTool({
              name: 'cap.mail.triageLatest',
              arguments: input,
            });
            return typeof result === 'string' ? result : JSON.stringify(result);
          },
        });
        allTools.push(mailTriageTool);
      }

      this.logger.log(
        `✅ Loaded ${capTools.length} CAP, ${cdsModelTools.length} cds-mcp (cached), ${braveSearchTools.length} Brave Search, ${filesystemTools.length} Filesystem, ${excelTools.length} Excel, und ${timeTools.length} Time tools (${postgresTools.length} PostgreSQL tools aktuell deaktiviert) + 1 Claims-Zusammenfassungstool`,
      );
      this.logger.log('Available tools:', allTools.map((tool) => tool.name));

      const llm = new AzureOpenAiChatClient({ modelName: 'gpt-4.1' });
      const checkpointer = new MemorySaver();

      const triageTools: StructuredToolInterface[] = mailTriageTool ? [mailTriageTool] : [];
      const claimsDataTools: StructuredToolInterface[] = [cachedSearchModelTool, claimsListSummaryTool];
      const capReadTool = capTools.find((tool) => tool.name === 'cap.cqn.read');
      if (capReadTool) {
        claimsDataTools.push(capReadTool);
      }
      const routedGeneralTools = allTools.filter((tool) => tool !== mailTriageTool);

      if (triageTools.length === 0 && claimsDataTools.length === 0) {
        this.logger.log('⚠️ Kein dediziertes CAP-Triage-Tool gefunden – falle auf Single-Agent zurück.');
        this.agentExecutor = createReactAgent({
          llm,
          tools: routedGeneralTools,
          checkpointSaver: checkpointer,
        });
        return this.agentExecutor;
      }

      const triageAgent = createReactAgent({
        llm,
        tools: triageTools,
        stateModifier: new SystemMessage(
          'Du bist der ClaimAI Triage-Agent. Fasse den neuesten Posteingangseintrag zusammen, bewerte Priorität und hebe relevante Anhänge hervor. Nutze ausschließlich CAP/M365 Werkzeuge.',
        ),
        checkpointSaver: checkpointer,
      });

      const generalAgent = createReactAgent({
        llm,
        tools: routedGeneralTools,
        stateModifier: new SystemMessage(
          'Du bist der ClaimAI Hauptexperte. Übernimm vorhandene Zwischenergebnisse der Triage und liefere eine strukturierte, handlungsorientierte Antwort für das Schadenmanagement.',
        ),
        checkpointSaver: checkpointer,
      });

      const claimsDataAgent = createReactAgent({
        llm,
        tools: claimsDataTools,
        stateModifier: new SystemMessage(
          'Du bist der ClaimAI Daten-Agent für Schadenfälle. Nutze zuerst `search_model` mit dem exakten Namen (z. B. "ClaimsService.Claims"), falls die Metadaten in dieser Unterhaltung noch nicht vorliegen. Verwende anschließend `cap.claims.list_summary`, um eine kompakte Liste (max. 20 Einträge) mit Status, Datum, Kosten sowie Fraud/Severity-Scores zu erzeugen. Gib niemals Roh-JSON zurück, sondern antworte in prägnantem Markdown auf Deutsch und schlage bei Bedarf sinnvolle nächste Schritte vor.',
        ),
        checkpointSaver: checkpointer,
      });

      const routerNode = (state: typeof MessagesAnnotation.State): Command => {
        const lastUserMessage = [...state.messages]
          .reverse()
          .find((message) => message.getType && message.getType() === 'human');
        const lastUserText = extractMessageText(lastUserMessage);
        const triageCompleted = state.messages.some(
          (message) => message.getType && message.getType() === 'ai' && message.name === 'triage_agent',
        );
        const generalCompleted = state.messages.some(
          (message) => message.getType && message.getType() === 'ai' && message.name === 'general_agent',
        );
        const claimsCompleted = state.messages.some(
          (message) => message.getType && message.getType() === 'ai' && message.name === 'claims_data_agent',
        );

        const requiresTriage =
          /triage|inbox|nachricht|mail|postfach|anhang|attachment|e-mail|email/i.test(lastUserText) &&
          !triageCompleted;
        const requiresClaimsData = isClaimsDataIntent(lastUserText) && !claimsCompleted;

        if (requiresTriage) {
          return new Command({ goto: 'triage_agent' });
        }

        if (requiresClaimsData) {
          return new Command({ goto: 'claims_data_agent' });
        }

        if (claimsCompleted) {
          return new Command({ goto: '__end__' });
        }

        if (!generalCompleted) {
          return new Command({ goto: 'general_agent' });
        }

        return new Command({ goto: '__end__' });
      };

      const triageNode = async (
        state: typeof MessagesAnnotation.State,
        config?: RunnableConfig,
      ): Promise<Command> => {
        const result = await triageAgent.invoke(state, config);
        const lastMessage = result.messages[result.messages.length - 1];
        const updates: AIMessage[] = [];
        if (lastMessage && isAIMessage(lastMessage)) {
          lastMessage.name = 'triage_agent';
          updates.push(lastMessage);
        }
        return new Command({
          goto: 'router',
          update: updates.length ? { messages: updates } : undefined,
        });
      };

      const generalNode = async (
        state: typeof MessagesAnnotation.State,
        config?: RunnableConfig,
      ): Promise<Command> => {
        const result = await generalAgent.invoke(state, config);
        const lastMessage = result.messages[result.messages.length - 1];
        const updates: AIMessage[] = [];
        if (lastMessage && isAIMessage(lastMessage)) {
          lastMessage.name = 'general_agent';
          updates.push(lastMessage);
        }
        return new Command({
          goto: 'router',
          update: updates.length ? { messages: updates } : undefined,
        });
      };

      const claimsDataNode = async (
        state: typeof MessagesAnnotation.State,
        config?: RunnableConfig,
      ): Promise<Command> => {
        const result = await claimsDataAgent.invoke(state, config);
        const lastMessage = result.messages[result.messages.length - 1];
        const updates: AIMessage[] = [];
        if (lastMessage && isAIMessage(lastMessage)) {
          lastMessage.name = 'claims_data_agent';
          updates.push(lastMessage);
        }
        return new Command({
          goto: 'router',
          update: updates.length ? { messages: updates } : undefined,
        });
      };

      const graphBuilder = new StateGraph(MessagesAnnotation)
        .addNode('router', routerNode, { ends: ['triage_agent', 'claims_data_agent', 'general_agent', '__end__'] })
        .addNode('triage_agent', triageNode, { ends: ['router'] })
        .addNode('claims_data_agent', claimsDataNode, { ends: ['router'] })
        .addNode('general_agent', generalNode, { ends: ['router', '__end__'] })
        .addEdge(START, 'router');

      const compiledGraph = graphBuilder.compile({ checkpointer });
      this.agentExecutor = compiledGraph as unknown as AgentExecutor;

      this.logger.log('✅ Multi-Agent LangGraph initialisiert (Router + Triage-Agent + Claims-Data-Agent + General-Agent).');
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
