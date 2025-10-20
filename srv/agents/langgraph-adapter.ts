import { loadMcpTools } from '@langchain/mcp-adapters';
import { createReactAgent } from '@langchain/langgraph/prebuilt';
import { AzureOpenAiChatClient } from '@sap-ai-sdk/langchain';
import { OrchestrationClient } from '@sap-ai-sdk/langchain';
import { MemorySaver } from '@langchain/langgraph-checkpoint';
import { DynamicStructuredTool } from '@langchain/core/tools';
import type { StructuredToolInterface } from '@langchain/core/tools';
import * as z from 'zod';
import MarkdownConverter from '../utils/markdown-converter.js';
import { createUIResource } from '@mcp-ui/server';
import { jsonSchemaToZod } from '../m365-mcp/mcp-jsonschema.js';
import type { initAllMCPClients } from '../lib/mcp-client.js';
import type { AgentAdapter, AgentCallOptions, AgentCallResult } from './agent-adapter.js';
import { analyzeImageAttachment } from '../utils/vision.js';

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

  async call(options: AgentCallOptions): Promise<AgentCallResult> {
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
      let lastToolOutputText = '';
      let lastImageDescription = '';
      let detectedUiResource: any | null = null;
      this.logger.log('\n\n---- AGENT STREAM START ----\n');

      for await (const chunk of stream) {
        if (chunk.agent?.messages) {
          const message = chunk.agent.messages[chunk.agent.messages.length - 1];
          if (message && message.content) {
            const c: any = message.content as any;
            let text = '';
            if (typeof c === 'string') text = c;
            else if (Array.isArray(c)) text = c.map((p: any) => (typeof p === 'string' ? p : (p?.text || ''))).filter(Boolean).join('\n');
            else if (c && typeof c === 'object') text = (c as any).text || '';
            if (text) {
              process.stdout.write(text);
              finalResponseParts.push(text);
            }
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
          const toolMessage: any = chunk.tools.messages[0];
          const content = toolMessage?.content;
          let toolText = '';
          if (typeof content === 'string') toolText = content;
          else if (Array.isArray(content)) toolText = content.map((p: any) => (typeof p === 'string' ? p : (p?.text || ''))).filter(Boolean).join('\n');
          else if (content) toolText = JSON.stringify(content);

          const toolOutputStr = `<TOOL_OUTPUT>\n  ${toolText}\n</TOOL_OUTPUT>\n\n`;
          process.stdout.write(toolOutputStr);

          if (toolText) lastToolOutputText = toolText;
          try {
            const trimmed = (toolText || '').trim();
            if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
              const parsed = JSON.parse(trimmed);
              if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && typeof (parsed as any).description === 'string') {
                lastImageDescription = (parsed as any).description as string;
              }
              // Detect UIResource returned by tools such as draft.mail.compose
              if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                const maybeRes = (parsed as any).uiResource || (parsed as any).resource || null;
                if (maybeRes && typeof maybeRes === 'object' && (maybeRes as any).uri) {
                  detectedUiResource = maybeRes;
                }
              }
            }
          } catch { }
        }
      }
      this.logger.log('\n---- AGENT STREAM END ----\n');

      let rawResponse = finalResponseParts.join('');
      if (!rawResponse || !rawResponse.trim()) {
        if (lastImageDescription) {
          rawResponse = `Kurzbeschreibung zum Foto: ${lastImageDescription}`;
        } else if (lastToolOutputText) {
          const t = lastToolOutputText.length > 1600 ? `${lastToolOutputText.slice(0, 1599)}…` : lastToolOutputText;
          rawResponse = `Werkzeug-Ergebnis:\n${t}`;
        } else {
          rawResponse = 'Die Aktion wurde ausgeführt, es wurde jedoch keine Antwort generiert.';
        }
      }

      return { response: MarkdownConverter.convertForClaims(rawResponse), uiResource: detectedUiResource || undefined };
    });
  }

  private async ensureAgentExecutor(): Promise<AgentExecutor> {
    if (this.agentExecutor) {
      return this.agentExecutor;
    }

    this.logLangSmithState();
    this.logger.log(
      'Initializing Agent with CAP data access, Filesystem, Excel, Microsoft 365, and Time capabilities...',
    );

    const clients = await this.ensureMcpClients();

    try {
      const loadSafely = async (names: string, client: unknown, label: string) => {
        try {
          const tools = await loadMcpTools(names, client as any);
          // Some adapters may return a single tool; normalize to array
          return Array.isArray(tools) ? (tools as StructuredToolInterface[]) : ([] as StructuredToolInterface[]);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.logger.warn?.(`Skipping ${label} tools: ${msg}`);
          return [] as StructuredToolInterface[];
        }
      };

      const [capTools, cdsModelTools, filesystemTools, excelTools, timeTools] =
        await Promise.all<StructuredToolInterface[]>([
          loadSafely('cap', clients.cap, 'CAP'),
          loadSafely('search_model', clients.cdsModel, 'cds-mcp'),
          loadSafely(
            // Intentionally exclude create_directory to prevent agents from writing outside the
            // sanctioned temp directory. Directory creation is handled by server-side helpers.
            'read_file,write_file,edit_file,list_directory,move_file,search_files,get_file_info,list_allowed_directories',
            clients.filesystem,
            'Filesystem',
          ),
          loadSafely(
            'excel_describe_sheets,excel_read_sheet,excel_screen_capture,excel_write_to_sheet,excel_create_table,excel_copy_sheet',
            clients.excel,
            'Excel',
          ),
          loadSafely('get_current_time,convert_time', clients.time, 'Time'),
        ]) as unknown as StructuredToolInterface[][];

      const postgresTools: StructuredToolInterface[] = [];
      const allTools = [
        ...postgresTools,
        ...cdsModelTools,
        ...capTools,
        // ...braveSearchTools,
        ...filesystemTools,
        ...excelTools,
        ...timeTools,
      ];

      if (clients.m365) {
        this.logger.log('Loading Microsoft 365 tools...');
        const manifest = await clients.m365.listTools();
        const enableSendTools = isTruthy(process.env.ENABLE_M365_SEND);
        // Always hide reply tools – sending happens via UI flow, not via MCP reply
        const blockedM365Tools = new Set<string>([
          'mail.message.reply',
        ]);
        // Optionally block calendar sending when not enabled
        if (!enableSendTools) {
          blockedM365Tools.add('calendar.event.create');
        }
        const filteredTools = manifest.tools.filter((toolDef) => {
          if (blockedM365Tools.has(toolDef.name)) {
            this.logger.log(`⛔️ Hiding Microsoft 365 tool from agent: ${toolDef.name}`);
            return false;
          }
          return true;
        });

        const m365Tools = filteredTools.map((toolDef) => {
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
        this.logger.log(
          `✅ Loaded ${m365Tools.length} Microsoft 365 tools${enableSendTools ? ' (send enabled)' : ' (reply/send tools excluded)'}`,
        );

        const mailDraftTool = new DynamicStructuredTool({
          name: 'draft.mail.compose',
          description: 'Erstellt ausschließlich einen E-Mail-Entwurf (ohne Versand) und gibt eine strukturierte Vorschau zurück.',
          schema: z.object({
            to: z.array(z.string()).optional().describe('E-Mail-Adressen der Empfänger. Optional; kann leer bleiben.'),
            cc: z.array(z.string()).optional().describe('CC-Empfänger (optional).'),
            bcc: z.array(z.string()).optional().describe('BCC-Empfänger (optional).'),
            subject: z.string().min(1).describe('Betreffzeile der E-Mail.'),
            body: z.string().min(1).describe('Kompletter Nachrichtentext (Plain Text oder HTML).'),
            contentType: z.enum(['Text', 'HTML']).default('Text').describe('Form des Inhalts. Standard: Text.')
          }),
          func: async (input) => {
            const preview = {
              to: input.to ?? [],
              cc: input.cc ?? [],
              bcc: input.bcc ?? [],
              subject: input.subject,
              contentType: input.contentType ?? 'Text',
              bodyPreview: input.body.slice(0, 320),
              body: input.body,
              createdAt: new Date().toISOString()
            };

            // Best practice (mcp-ui): include a UIResource in the tool output
            // We reference the same-origin PoC endpoint and prefill values via query params
            const to0 = Array.isArray(preview.to) && preview.to.length ? String(preview.to[0]) : 'hoang.duong@pureconsulting.ch';
            const from0 = 'hoang.duong@purecons.net';
            const subject0 = preview.subject || '';
            const body0 = preview.body || '';
            const jsFrom = JSON.stringify(from0);
            const jsTo = JSON.stringify(to0);
            const jsSubject = JSON.stringify(subject0);
            const jsBody = JSON.stringify(body0);
            const html = `
          <style>
            html, body { margin: 0; padding: 0; background: transparent; overflow: hidden; }
            .card-shell { font-family: Arial, sans-serif; padding: 0; margin: 0; }
            .grid { display: grid; grid-template-columns: 88px 1fr; gap: 12px; width: 100%; box-sizing: border-box; }
            .row { display: contents; }
            .label { color: #64748b; font-size: 12px; font-weight: 600; align-self: center; text-transform: uppercase; letter-spacing: .4px; padding: 12px 0; }
            .value { padding: 8px 0; }
            .divider { grid-column: 1 / -1; height: 1px; background: #e5e7eb; }
            ui5-card { width: 100%; }
            ui5-input, ui5-textarea { width: 100%; }
            .actions { display: flex; gap: 8px; padding-top: 12px; }
          </style>
          <div class="card-shell">
            <ui5-card id="emailCard" accessible-name="Email draft">
              <div class="grid">
                <div class="label">VON</div>
                <div class="value" id="fromValue"></div>
                <div class="divider"></div>

                <div class="label">AN</div>
                <div class="value"><ui5-input id="toInput" placeholder="name@example.com" required></ui5-input></div>
                <div class="divider"></div>

                <div class="label">BETREFF</div>
                <div class="value"><ui5-input id="subjectInput" placeholder="Email subject" required></ui5-input></div>
                <div class="divider"></div>

                <div class="label"></div>
                <div class="value"><ui5-textarea id="bodyInput" rows="9" placeholder="Write your message…"></ui5-textarea></div>
              </div>
            </ui5-card>

            <div class="actions">
              <ui5-button id="sendBtn" design="Emphasized">E-Mail senden</ui5-button>
              <ui5-button id="discardBtn" design="Transparent">Verwerfen</ui5-button>
            </div>

            <script type="module">
              import 'https://esm.sh/@ui5/webcomponents@1.24.0/dist/Assets.js';
              import 'https://esm.sh/@ui5/webcomponents@1.24.0/dist/Card.js';
              import 'https://esm.sh/@ui5/webcomponents@1.24.0/dist/Input.js';
              import 'https://esm.sh/@ui5/webcomponents@1.24.0/dist/TextArea.js';
              import 'https://esm.sh/@ui5/webcomponents@1.24.0/dist/Button.js';

              const from = ${jsFrom};
              const to = ${jsTo};
              const subject = ${jsSubject};
              const body = ${jsBody};

              const fromValue = document.getElementById('fromValue');
              const toInput = document.getElementById('toInput');
              const subjectInput = document.getElementById('subjectInput');
              const bodyInput = document.getElementById('bodyInput');
              const sendBtn = document.getElementById('sendBtn');
              const discardBtn = document.getElementById('discardBtn');

              fromValue.textContent = from;
              toInput.value = to;
              subjectInput.value = subject;
              bodyInput.value = body;

              const isEmail = (v) => /.+@.+\..+/.test(String(v).trim());
              const isValid = () => {
                const okTo = isEmail(toInput.value);
                const okSub = String(subjectInput.value).trim().length > 0;
                const okBody = String(bodyInput.value).trim().length > 0;
                toInput.valueState = okTo ? 'None' : 'Negative';
                subjectInput.valueState = okSub ? 'None' : 'Negative';
                bodyInput.valueState = okBody ? 'None' : 'Negative';
                return okTo && okSub && okBody;
              };

              const currentDraft = () => ({ from: fromValue.textContent || '', to: toInput.value, subject: subjectInput.value, body: bodyInput.value });
              const post = (type, payload) => { try { window.parent && window.parent.postMessage({ type, payload }, '*'); } catch (_) {} };
              const onChange = () => { /* Keep valueState highlighting; do not disable the button */ post('ui-state-change', currentDraft()); };
              toInput.addEventListener('input', onChange);
              subjectInput.addEventListener('input', onChange);
              bodyInput.addEventListener('input', onChange);
              onChange();

              sendBtn.addEventListener('click', () => { if (!isValid()) return; post('tool', { toolName: 'email.send', params: currentDraft() }); });
              discardBtn.addEventListener('click', () => post('tool', { toolName: 'email.discard', params: { draft: currentDraft() } }));

              try {
                const ro = new ResizeObserver((entries) => {
                  for (const entry of entries) {
                    const h = Math.ceil(entry.contentRect.height);
                    window.parent.postMessage({ type: 'ui-size-change', payload: { height: h } }, '*');
                  }
                });
                ro.observe(document.documentElement);
              } catch (_) {}
            </script>
          </div>`;
            const ui = createUIResource({
              uri: `ui://draft/email/${Date.now()}`,
              content: { type: 'rawHtml', htmlString: html },
              encoding: 'text',
              metadata: {
                title: 'Draft Email – Composer',
                'mcpui.dev/ui-preferred-frame-size': ['100%', '520px']
              }
            });

            return JSON.stringify({
              status: 'draft-prepared',
              channel: 'mail',
              draft: preview,
              // Provide the resource object for hosts to render directly
              uiResource: ui.resource
            });
          }
        });

        const calendarDraftTool = new DynamicStructuredTool({
          name: 'draft.calendar.compose',
          description: 'Bereitet einen Kalendereintrag als Entwurf vor (keine Einladung wird versendet).',
          schema: z.object({
            subject: z.string().min(1).describe('Betreff / Titel des Termins.'),
            startDateTime: z.string().min(1).describe('Startzeit in ISO-8601. Beispiel: 2024-12-01T09:00:00.'),
            endDateTime: z.string().min(1).describe('Endzeit in ISO-8601. Beispiel: 2024-12-01T10:00:00.'),
            timezone: z.string().optional().describe('Zeitzone für Start/Ende, z. B. Europe/Berlin.'),
            attendees: z.array(z.string()).optional().describe('E-Mail-Adressen der eingeladenen Teilnehmer (optional).'),
            location: z.string().optional().describe('Ort oder Meeting-Link (optional).'),
            body: z.string().optional().describe('Beschreibung / Agenda des Termins.'),
            contentType: z.enum(['Text', 'HTML']).default('Text').describe('Beschreibung als Text oder HTML, Standard: Text.'),
            reminderMinutesBeforeStart: z.number().optional().describe('Erinnerung in Minuten vor Start (optional).')
          }),
          func: async (input) => {
            const preview = {
              subject: input.subject,
              startDateTime: input.startDateTime,
              endDateTime: input.endDateTime,
              timezone: input.timezone ?? 'UTC',
              attendees: input.attendees ?? [],
              location: input.location ?? null,
              body: input.body ?? '',
              contentType: input.contentType ?? 'Text',
              reminderMinutesBeforeStart: input.reminderMinutesBeforeStart ?? null,
              bodyPreview: (input.body ?? '').slice(0, 320),
              createdAt: new Date().toISOString()
            };

            return JSON.stringify({
              status: 'draft-prepared',
              channel: 'calendar',
              draft: preview
            });
          }
        });

        allTools.push(mailDraftTool, calendarDraftTool);
      }

      // Local Vision tool to describe images (aligns with productive service behavior)
      const imageDescribeTool = new DynamicStructuredTool({
        name: 'image.describe',
        description: 'Beschreibt eine lokale Bilddatei (png/jpg/jpeg/webp) und liefert EXIF-Metadaten.',
        schema: z.object({
          fileAbsolutePath: z.string().min(1).describe('Absoluter Pfad zur Bilddatei.'),
          prompt: z.string().optional().describe('Optionaler Hinweis/Task für die Bildanalyse.'),
        }),
        func: async (input) => {
          const { fileAbsolutePath, prompt } = input as { fileAbsolutePath: string; prompt?: string };
          const result = await analyzeImageAttachment(fileAbsolutePath, { prompt });
          return JSON.stringify(result);
        }
      });
      allTools.push(imageDescribeTool);

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
        `✅ Loaded ${capTools.length} CAP, ${cdsModelTools.length} cds-mcp, ${filesystemTools.length} Filesystem, ${excelTools.length} Excel, and ${timeTools.length} Time tools (${postgresTools.length} PostgreSQL tools currently disabled)`,
      );
      this.logger.log('Available tools:', allTools.map((tool) => tool.name));

      // const llm = new AzureOpenAiChatClient({ modelName: 'gpt-5-mini' });
      const llm = new AzureOpenAiChatClient({ modelName: 'gpt-4.1', temperature: 0 });
      // const llm = new OrchestrationClient({
      //   promptTemplating: {
      //     model: {
      //       name: 'gpt-4.1'
      //     }
      //   }
      // });
      const checkpointer = new MemorySaver();

      this.agentExecutor = createReactAgent({
        llm,
        tools: allTools,
        checkpointSaver: checkpointer,
      });

      this.logger.log(
        '✅ Multi-Modal Agent is ready (Database + Filesystem + Excel + M365 + Time).',
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
