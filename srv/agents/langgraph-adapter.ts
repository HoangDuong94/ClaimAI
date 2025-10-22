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
import { promises as fs } from 'fs';
import path from 'path';

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
          // Always keep calendar send hidden – creation handled deterministically via UI flow
          'calendar.event.create',
        ]);
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
              // Load localization assets so calendar types (Gregorian) & CLDR data are available
              import 'https://esm.sh/@ui5/webcomponents-localization@1.24.0/dist/Assets.js';
              import 'https://esm.sh/@ui5/webcomponents-localization@1.24.0/dist/features/calendar/Gregorian.js';
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

            // Build an interactive UI card (UI5 Web Components) for calendar composing
            const subject0 = preview.subject || '';
            const start0 = preview.startDateTime || '';
            const end0 = preview.endDateTime || '';
            const tz0 = preview.timezone || 'UTC';
            const attendees0 = Array.isArray(preview.attendees) ? preview.attendees.join(', ') : '';
            const location0 = preview.location || '';
            const body0 = preview.body || '';
            const jsSubject = JSON.stringify(subject0);
            const jsStart = JSON.stringify(start0);
            const jsEnd = JSON.stringify(end0);
            const jsTz = JSON.stringify(tz0);
            const jsAttendees = JSON.stringify(attendees0);
            const jsLocation = JSON.stringify(location0);
            const jsBody = JSON.stringify(body0);

            const html = `
          <style>
            html, body { margin: 0; padding: 0; background: transparent; overflow: hidden; }
            .card-shell { font-family: var(--sapFontFamily, Arial, sans-serif); font-size: var(--sapFontSize, 14px); color: var(--sapTextColor, #1d2d3e); padding: 0; margin: 0; }
            .grid { display: grid; grid-template-columns: 140px 1fr; gap: 12px; width: 100%; box-sizing: border-box; }
            .row { display: contents; }
            .label { color: var(--sapContent_LabelColor, #556b82); font-size: 12px; font-weight: 600; align-self: center; text-transform: uppercase; letter-spacing: .4px; padding: 12px 0; }
            .value { padding: 8px 0; }
            .divider { grid-column: 1 / -1; height: 1px; background: var(--sapContent_ForegroundBorderColor, #758ca4); opacity: .25; }
            ui5-card { width: 100%; }
            ui5-input, ui5-textarea, input[type="date"], input[type="time"] { width: 100%; box-sizing: border-box; }
            .two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
            .actions { display: flex; gap: 8px; padding-top: 12px; }

            /* UI5-like styles for native date/time inputs */
            .ui5-like-input {
              background: var(--sapField_Background, #fff);
              color: var(--sapField_TextColor, var(--sapTextColor, #1d2d3e));
              border: var(--sapElement_BorderWidth, 1px) solid var(--sapField_BorderColor, var(--sapContent_ForegroundBorderColor, #758ca4));
              border-radius: var(--sapElement_BorderCornerRadius, .5rem);
              min-height: var(--sapElement_Height, 2.25rem);
              height: var(--sapElement_Height, 2.25rem);
              padding: 0 .625rem;
              line-height: calc(var(--sapElement_Height, 2.25rem) - 2 * var(--sapElement_BorderWidth, 1px));
              outline: none;
              box-shadow: var(--sapContent_Interaction_Shadow, inset 0 0 0 1px rgba(85,107,129,.25));
              transition: border-color .12s ease, box-shadow .12s ease, background .12s ease;
            }
            .ui5-like-input::placeholder { color: var(--sapField_PlaceholderTextColor, #6a788e); opacity: .8; }
            .ui5-like-input:hover {
              background: var(--sapField_Hover_Background, var(--sapHoverColor, #eaecee));
              border-color: var(--sapField_Hover_BorderColor, var(--sapContent_ForegroundBorderColor, #758ca4));
            }
            .ui5-like-input:focus {
              border-color: var(--sapContent_FocusColor, #0032a5);
              box-shadow: 0 0 0 var(--sapContent_FocusWidth, .125rem) var(--sapContent_FocusColor, #0032a5);
            }
            .ui5-like-input[aria-invalid="true"] { border-color: var(--sapErrorBorderColor, #e90b0b); }
            .ui5-like-input:disabled { opacity: var(--sapContent_DisabledOpacity, .4); cursor: not-allowed; }
          </style>
          <div class="card-shell">
            <ui5-card id="calCard" accessible-name="Calendar draft">
              <div class="grid">
                <div class="label">BETREFF</div>
                <div class="value"><ui5-input id="subjectInput" placeholder="Titel des Termins" required></ui5-input></div>
                <div class="divider"></div>

                <div class="label">ZEITRAUM</div>
                <div class="value">
                  <div class="two-col" style="margin-bottom: 6px;">
                    <input class="ui5-like-input" id="startDate" type="date" placeholder="Start-Datum (YYYY-MM-DD)" />
                    <input class="ui5-like-input" id="startTime" type="time" placeholder="Start-Zeit (HH:mm)" />
                  </div>
                  <div class="two-col" style="margin-bottom: 6px;">
                    <input class="ui5-like-input" id="endDate" type="date" placeholder="End-Datum (YYYY-MM-DD)" />
                    <input class="ui5-like-input" id="endTime" type="time" placeholder="End-Zeit (HH:mm)" />
                  </div>
                  <div id="periodPreview" style="color:#475569; font-size: 12px;">–</div>
                </div>
                <div class="divider"></div>

                <div class="label">ZEITZONE</div>
                <div class="value"><ui5-input id="tzInput" placeholder="Europe/Berlin"></ui5-input></div>
                <div class="divider"></div>

                <div class="label">TEILNEHMER</div>
                <div class="value"><ui5-input id="attendeesInput" placeholder="email1@example.com; email2@example.com"></ui5-input></div>
                <div class="divider"></div>

                <div class="label">ORT</div>
                <div class="value"><ui5-input id="locationInput" placeholder="MS Teams / Online"></ui5-input></div>
                <div class="divider"></div>

                <div class="label">BESCHREIBUNG</div>
                <div class="value"><ui5-textarea id="bodyInput" rows="6" placeholder="Agenda oder Beschreibung…"></ui5-textarea></div>
                <div class="divider"></div>

                <div class="label">ONLINE</div>
                <div class="value"><ui5-switch id="teamsSwitch" accessible-name="Online-Meeting (Teams)"></ui5-switch></div>
              </div>
            </ui5-card>

            <div class="actions">
              <ui5-button id="createBtn" design="Emphasized">Termin erstellen</ui5-button>
              <ui5-button id="discardBtn" design="Transparent">Verwerfen</ui5-button>
            </div>

            <script type="module">
              // Minimal UI5 footprint – no date/time pickers to avoid calendar deps
              import 'https://esm.sh/@ui5/webcomponents@1.24.0/dist/Assets.js';
              import 'https://esm.sh/@ui5/webcomponents@1.24.0/dist/Card.js';
              import 'https://esm.sh/@ui5/webcomponents@1.24.0/dist/Input.js';
              import 'https://esm.sh/@ui5/webcomponents@1.24.0/dist/TextArea.js';
              import 'https://esm.sh/@ui5/webcomponents@1.24.0/dist/Button.js';
              import 'https://esm.sh/@ui5/webcomponents@1.24.0/dist/Switch.js';

              const subject = ${jsSubject};
              const startDT = ${jsStart};
              const endDT = ${jsEnd};
              const tz = ${jsTz};
              const attendees = ${jsAttendees};
              const location = ${jsLocation};
              const body = ${jsBody};

              const subjectInput = document.getElementById('subjectInput');
              const startDate = document.getElementById('startDate');
              const startTime = document.getElementById('startTime');
              const endDate = document.getElementById('endDate');
              const endTime = document.getElementById('endTime');
              const tzInput = document.getElementById('tzInput');
              const attendeesInput = document.getElementById('attendeesInput');
              const locationInput = document.getElementById('locationInput');
              const bodyInput = document.getElementById('bodyInput');
              const createBtn = document.getElementById('createBtn');
              const discardBtn = document.getElementById('discardBtn');
              const teamsSwitch = document.getElementById('teamsSwitch');

              const splitDate = (dt) => { const s = String(dt||''); const i = s.indexOf('T'); return i>0 ? [s.slice(0,i), s.slice(i+1)] : [s,'']; };
              const setInitialValues = () => {
                subjectInput.value = subject;
                tzInput.value = tz;
                attendeesInput.value = attendees;
                locationInput.value = location;
                bodyInput.value = body;
                // For UI5 elements, ensure property set occurs after upgrade
                const [sd, st] = splitDate(startDT);
                const [ed, et] = splitDate(endDT);
                try { startDate.value = sd; } catch(_) {}
                try { startTime.value = (st||'').slice(0,5); } catch(_) {}
                try { endDate.value = ed; } catch(_) {}
                try { endTime.value = (et||'').slice(0,5); } catch(_) {}
                try {
                  if (teamsSwitch) {
                    const shouldCheck = /teams/i.test(String(location)) || /online/i.test(String(location));
                    if (shouldCheck) {
                      teamsSwitch.checked = true;
                      teamsSwitch.setAttribute('checked', '');
                    } else {
                      teamsSwitch.checked = false;
                      teamsSwitch.removeAttribute('checked');
                    }
                  }
                } catch(_) {}
                // Trigger preview + state sync after values applied
                try { updatePeriodPreview(); } catch(_) {}
                try { onChange(); } catch(_) {}
              };
              const afterNextFrame = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
              Promise.all([
                customElements.whenDefined('ui5-input'),
                customElements.whenDefined('ui5-textarea'),
                customElements.whenDefined('ui5-switch'),
              ])
              .then(setInitialValues)
              .catch(() => setTimeout(() => { try { setInitialValues(); } catch(_) {} }, 200));

              const normalizeList = (s) => String(s || '').split(/[;,]/g).map(x => x.trim()).filter(Boolean);
              const composeIso = (d, t) => {
                const dd = String(d || '').trim();
                let tt = String(t || '').trim();
                if (!dd || !tt) return '';
                if (/^\d{2}:\d{2}$/.test(tt)) tt = tt + ':00';
                return dd + 'T' + tt;
              };
              const isIso = (v) => {
                const s = String(v || '').trim();
                if (!s || s.indexOf('T') < 0) return false;
                const d = new Date(s);
                return !isNaN(d.getTime());
              };
              const isEmail = (v) => { const s = String(v || '').trim(); return !!s && s.includes('@') && !s.includes(' ') && s.includes('.'); };
              const validAttendees = (s) => normalizeList(s).every(x => isEmail(x.replace(/[<>()]/g, '').replace(/^.*<([^>]+)>.*/, '$1')));
              const isValid = () => {
                const okSub = String(subjectInput.value).trim().length > 0;
                const okStart = isIso(composeIso(startDate.value, startTime.value));
                const okEnd = isIso(composeIso(endDate.value, endTime.value));
                const okTz = String(tzInput.value).trim().length > 0;
                const okAtt = !attendeesInput.value || validAttendees(attendeesInput.value);
                const setVS = (el, ok) => { try { if (el && 'valueState' in el) el.valueState = ok ? 'None' : 'Negative'; else if (el && el.toggleAttribute) el.toggleAttribute('aria-invalid', !ok); } catch(_) {} };
                setVS(subjectInput, okSub);
                setVS(startDate, okStart);
                setVS(startTime, okStart);
                setVS(endDate, okEnd);
                setVS(endTime, okEnd);
                setVS(tzInput, okTz);
                setVS(attendeesInput, okAtt);
                return okSub && okStart && okEnd && okTz && okAtt;
              };

              const currentDraft = () => ({
                subject: subjectInput.value,
                startDateTime: composeIso(startDate.value, startTime.value),
                endDateTime: composeIso(endDate.value, endTime.value),
                timezone: tzInput.value,
                attendees: normalizeList(attendeesInput.value),
                location: locationInput.value,
                body: bodyInput.value,
                contentType: 'Text',
                teams: Boolean(teamsSwitch?.checked)
              });
              const periodPreviewEl = document.getElementById('periodPreview');
              const updatePeriodPreview = () => {
                try {
                  const s = composeIso(startDate.value, startTime.value).trim();
                  const e = composeIso(endDate.value, endTime.value).trim();
                  const tzv = String(tzInput.value || '');
                  if (!s && !e) { periodPreviewEl.textContent = '–'; return; }
                  const left = s || '?';
                  const right = e ? ('–' + e) : '';
                  const tzs = tzv ? (' (' + tzv + ')') : '';
                  periodPreviewEl.textContent = left + right + tzs;
                } catch(_) { periodPreviewEl.textContent = '–'; }
              };
              const post = (type, payload) => { try { window.parent && window.parent.postMessage({ type, payload }, '*'); } catch (_) {} };
              const onChange = () => { post('ui-state-change', currentDraft()); };
              subjectInput.addEventListener('input', onChange);
              startDate.addEventListener('change', () => { onChange(); updatePeriodPreview(); });
              startTime.addEventListener('change', () => { onChange(); updatePeriodPreview(); });
              endDate.addEventListener('change', () => { onChange(); updatePeriodPreview(); });
              endTime.addEventListener('change', () => { onChange(); updatePeriodPreview(); });
              tzInput.addEventListener('input', () => { onChange(); updatePeriodPreview(); });
              attendeesInput.addEventListener('input', onChange);
              locationInput.addEventListener('input', onChange);
              bodyInput.addEventListener('input', onChange);

              createBtn.addEventListener('click', () => { if (!isValid()) return; post('tool', { toolName: 'calendar.create', params: currentDraft() }); });
              discardBtn.addEventListener('click', () => post('tool', { toolName: 'calendar.discard', params: { draft: currentDraft() } }));

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
              uri: `ui://draft/calendar/${Date.now()}`,
              content: { type: 'rawHtml', htmlString: html },
              encoding: 'text',
              metadata: {
                title: 'Draft Calendar – Composer',
                'mcpui.dev/ui-preferred-frame-size': ['100%', '560px']
              }
            });

            return JSON.stringify({
              status: 'draft-prepared',
              channel: 'calendar',
              draft: preview,
              uiResource: ui.resource
            });
          }
        });

        allTools.push(mailDraftTool, calendarDraftTool);
      }

      // Attachments gallery UI tool (image preview card)
      const attachmentsGalleryTool = new DynamicStructuredTool({
        name: 'attachments.gallery.compose',
        description: 'Erzeugt eine UI-Karte mit Bildvorschau der Anhänge (Dateien werden als Base64 eingebettet).',
        schema: z.object({
          directory: z.string().optional().describe('Basisverzeichnis der Anhänge (Standard: tmp/attachments).'),
          files: z.array(z.string()).optional().describe('Optionale Liste konkreter Dateipfade relativ zum Verzeichnis oder absolut.'),
          maxItems: z.number().int().min(1).max(48).optional().describe('Maximale Anzahl Bilder (Standard: 12).'),
          title: z.string().optional().describe('Titel der Karte (Standard: Anhänge – Bilder).'),
        }),
        func: async (input) => {
          const directory = (input.directory && input.directory.trim()) || 'tmp/attachments';
          const title = (input.title && input.title.trim()) || 'Anhänge – Bilder';
          const maxItems = Number.isFinite(input.maxItems as number) ? Math.max(1, Math.min(48, Number(input.maxItems))) : 12;
          const allowedExt = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
          const toAbs = (p0: string) => (path.isAbsolute(p0) ? p0 : path.join(process.cwd(), p0));
          const baseDir = toAbs(directory);

          const guessMime = (file: string) => {
            const ext = path.extname(file).toLowerCase();
            if (ext === '.png') return 'image/png';
            if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
            if (ext === '.webp') return 'image/webp';
            if (ext === '.gif') return 'image/gif';
            return 'application/octet-stream';
          };

          let candidates: string[] = [];
          try {
            if (Array.isArray(input.files) && input.files.length) {
              candidates = input.files.map((f) => (path.isAbsolute(f) ? f : path.join(baseDir, f)));
            } else {
              const entries = await fs.readdir(baseDir, { withFileTypes: true });
              candidates = entries
                .filter((e) => e.isFile() && allowedExt.has(path.extname(e.name).toLowerCase()))
                .map((e) => path.join(baseDir, e.name));
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            const ui = createUIResource({
              uri: `ui://attachments/gallery/${Date.now()}`,
              content: { type: 'rawHtml', htmlString: `<div style="font-family: Arial, sans-serif; padding:12px; color:#b00020">Fehler beim Lesen der Anhänge: ${msg}</div>` },
              encoding: 'text',
              metadata: { title: 'Anhänge – Fehler', 'mcpui.dev/ui-preferred-frame-size': ['100%', '120px'] },
            });
            return JSON.stringify({ status: 'error', message: msg, uiResource: ui.resource });
          }

          const attachmentsRoot = path.resolve(process.cwd(), 'tmp', 'attachments');
          const images: { name: string; mime: string; rel: string }[] = [];
          for (const file of candidates.slice(0, maxItems)) {
            const ext = path.extname(file).toLowerCase();
            if (!allowedExt.has(ext)) continue;
            const abs = path.resolve(file);
            const rel = path.relative(attachmentsRoot, abs);
            if (rel.startsWith('..') || path.isAbsolute(rel)) continue;
            const mime = guessMime(abs);
            images.push({ name: path.basename(abs), mime, rel: rel.split(path.sep).join('/') });
          }

          // Skip generating image descriptions to improve performance.

          const itemHtml = images
            .map((img, idx) => {
              const safeAlt = img.name.replace(/\"/g, '&quot;');
              const src = `/service/claims/ui/attachment?file=${encodeURIComponent(img.rel)}`;
              return `<ui5-media-gallery-item data-name=\"${safeAlt}\" data-path=\"${img.rel}\" data-index=\"${idx}\"><img src=\"${src}\" alt=\"${safeAlt}\" loading=\"lazy\" style=\"max-width:100%;height:auto;display:block\" /></ui5-media-gallery-item>`;
            })
            .join('\n');

          const emptyHtml = images.length === 0 ? `<div style="padding: 16px; color: var(--sapContent_LabelColor, #556b82);">Keine Bilder gefunden in <code>${directory}</code>.</div>` : '';

          const html = `
          <style>
            html, body { margin: 0; padding: 0; background: transparent; overflow: hidden; }
            .card-shell { font-family: var(--sapFontFamily, Arial, sans-serif); font-size: var(--sapFontSize, 14px); color: var(--sapTextColor, #1d2d3e); padding: 0; margin: 0; }
            ui5-card { width: 100%; box-sizing: border-box; }
          </style>
          <div class="card-shell">
            <ui5-card id="attCard" accessible-name="Attachments gallery">
              <div style="padding: 8px 12px; display:flex; align-items:center; gap:8px;">
                <span style="font-weight:600; color: var(--sapTitleColor, #1d2d3e);">${title}</span>
                <span style="color: var(--sapContent_LabelColor, #556b82); font-size:12px;">(${images.length})</span>
              </div>
              ${images.length ? `<ui5-media-gallery id="gallery" show-all-thumbnails layout="Vertical">${itemHtml}</ui5-media-gallery>` : emptyHtml}
            </ui5-card>
            <script type="module">
              import 'https://esm.sh/@ui5/webcomponents@1.24.0/dist/Assets.js';
              import 'https://esm.sh/@ui5/webcomponents@1.24.0/dist/Card.js';
              import 'https://esm.sh/@ui5/webcomponents-fiori@1.24.0/dist/Assets.js';
              import 'https://esm.sh/@ui5/webcomponents-fiori@1.24.0/dist/MediaGallery.js';
              import 'https://esm.sh/@ui5/webcomponents-fiori@1.24.0/dist/MediaGalleryItem.js';
              const post = (type, payload) => { try { window.parent && window.parent.postMessage({ type, payload }, '*'); } catch (_) {} };
              const gallery = document.getElementById('gallery');
              if (gallery) {
                gallery.addEventListener('click', (e) => {
                  const item = e.target?.closest?.('ui5-media-gallery-item');
                  if (item) {
                    const name = item.getAttribute('data-name');
                    const path = item.getAttribute('data-path');
                    post('tool', { toolName: 'attachment.open', params: { name, path } });
                  }
                });
              }
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
            uri: `ui://attachments/gallery/${Date.now()}`,
            content: { type: 'rawHtml', htmlString: html },
            encoding: 'text',
            metadata: { title: 'Anhänge – Galerie', 'mcpui.dev/ui-preferred-frame-size': ['100%', '480px'] },
          });

          return JSON.stringify({ status: 'ok', count: images.length, uiResource: ui.resource });
        },
      });
      allTools.push(attachmentsGalleryTool);

      // Excel preview card tool: renders an Excel attachment inside a UI5 Card with TabContainer + Table
      const excelPreviewTool = new DynamicStructuredTool({
        name: 'excel.preview.card',
        description:
          'Erzeugt eine UI-Karte (UI5 Web Components) zur Vorschau einer Excel-Datei mit Reitern je Tabellenblatt und einer Tabellenansicht der ersten Zeilen.',
        schema: z.object({
          fileAbsolutePath: z.string().min(1).describe('Absoluter Pfad zur Excel-/CSV-Datei.'),
          maxRows: z.number().int().min(1).max(200).optional().describe('Maximale Anzahl Zeilen pro Blatt (Standard: 20).'),
          sheets: z.array(z.string()).optional().describe('Optionale Liste von Blattnamen, die vorzubereiten sind. Standard: alle Blätter.'),
        }),
        func: async (input) => {
          const abs = String((input as any).fileAbsolutePath || '').trim();
          if (!abs) return 'fileAbsolutePath fehlt';
          const maxRows = Number.isFinite((input as any).maxRows) ? Math.max(1, Math.min(200, Number((input as any).maxRows))) : 20;
          const wantedSheets: string[] | null = Array.isArray((input as any).sheets) ? (input as any).sheets : null;

          // Helper to coerce MCP tool response to plain text
          const toText = (out: any): string => {
            if (!out) return '';
            const s = (out as any).structuredContent;
            if (typeof s === 'string') return s;
            if (Array.isArray(s)) return s.map((p) => (typeof p === 'string' ? p : (p?.text || ''))).join('\n');
            const c = (out as any).content;
            if (typeof c === 'string') return c;
            if (Array.isArray(c)) return c.map((p) => (typeof p === 'string' ? p : (p?.text || ''))).join('\n');
            if (out?.text) return String(out.text);
            try { return JSON.stringify(out); } catch { return String(out); }
          };

          // Describe sheets (be defensive with server schema)
          const tryDescribe = async (): Promise<string[]> => {
            try {
              const manifest = await clients.excel.listTools({}, { timeout: 120000 });
              const available = new Set((manifest.tools || []).map((t) => t.name));
              if (!available.has('excel_describe_sheets')) return [];
              const candidates = ['Sheet1', 'Tabelle1', 'Sheet 1', 'Blatt1', 'ClaimHeader'];
              for (const nm of candidates) {
                try {
                  // Inspect schema to decide arg names
                  const toolDef = (manifest.tools || []).find((t) => t.name === 'excel_describe_sheets');
                  const props = (toolDef && (toolDef as any).inputSchema && (toolDef as any).inputSchema.properties) || {};
                  const args: any = { fileAbsolutePath: abs };
                  if (props.sheetName) { args.sheetName = nm; }
                  if (props.srcSheetName) { args.srcSheetName = nm; }
                  if (props.dstSheetName) { args.dstSheetName = nm; }
                  const res = await clients.excel.callTool({ name: 'excel_describe_sheets', arguments: args }, undefined, { timeout: 120000 });
                  const txt = toText(res);
                  // Try to parse JSON if present; otherwise attempt to extract names from plain text
                  let names: string[] = [];
                  try {
                    const json = JSON.parse(txt);
                    if (Array.isArray(json?.sheets)) names = json.sheets.map((s: any) => String(s?.name || s?.sheetName || s || '')).filter(Boolean);
                    else if (Array.isArray(json?.sheetNames)) names = json.sheetNames.filter((s: any) => typeof s === 'string');
                    else if (typeof json?.sheetName === 'string') names = [json.sheetName];
                  } catch {
                    // fallback: simple regex for sheet names in logs
                    const m = txt.match(/sheet\s*names?\s*:\s*\[(.*?)\]/i);
                    if (m && m[1]) {
                      names = m[1].split(',').map((p) => p.replace(/[\"'\s]/g, '')).filter(Boolean);
                    }
                  }
                  if (names.length) return names;
                } catch { /* try next */ }
              }
            } catch { /* ignore */ }
            return [];
          };

          let sheetNames = wantedSheets && wantedSheets.length ? wantedSheets : await tryDescribe();
          if (!sheetNames || sheetNames.length === 0) {
            sheetNames = ['Sheet1'];
          }

          // Limit number of prepared sheets to avoid huge payloads
          const MAX_SHEETS = 8;
          const prepared: Array<{ name: string; rawHtml: string }> = [];
          for (const sheetName of sheetNames.slice(0, MAX_SHEETS)) {
            try {
              const manifest = await clients.excel.listTools({}, { timeout: 120000 });
              const toolDef = (manifest.tools || []).find((t) => t.name === 'excel_read_sheet');
              const props = (toolDef && (toolDef as any).inputSchema && (toolDef as any).inputSchema.properties) || {};
              const args: any = { fileAbsolutePath: abs };
              if (props.sheetName) { args.sheetName = sheetName; }
              if (props.srcSheetName) { args.srcSheetName = sheetName; }
              if (props.dstSheetName) { args.dstSheetName = sheetName; }
              // Provide a conservative range if supported
              // Do not set a default range; some servers error if the range exceeds used range
              const res = await clients.excel.callTool({ name: 'excel_read_sheet', arguments: args }, undefined, { timeout: 180000 });
              const html = toText(res);
              prepared.push({ name: sheetName, rawHtml: html });
            } catch (e) {
              prepared.push({ name: sheetName, rawHtml: `<div style=\"color:#b00020\">Fehler beim Lesen des Blatts ${sheetName}: ${String((e as any)?.message || e)}<\/div>` });
            }
          }

          const path = await import('node:path');
          const fsPath = await import('node:fs');
          const absPath = path.default.resolve(abs);
          const fileName = path.default.basename(absPath);
          const attachmentsRoot = path.default.resolve(process.cwd(), 'tmp', 'attachments');
          let relForDownload: string | null = null;
          try {
            const rel = path.default.relative(attachmentsRoot, absPath).split(path.default.sep).join('/');
            if (!rel.startsWith('..') && !path.default.isAbsolute(rel) && fsPath.existsSync(path.default.join(attachmentsRoot, rel))) {
              relForDownload = rel;
            }
          } catch { relForDownload = null; }

          const clientModel = {
            fileName,
            fileAbsolutePath: absPath,
            maxRows,
            downloadUrl: relForDownload ? `/service/claims/ui/attachment?file=${encodeURIComponent(relForDownload)}` : null,
            sheets: prepared,
          };

          const html = `
<style>
  html, body { margin: 0; padding: 0; background: transparent; overflow: hidden; }
  .card-shell { font-family: var(--sapFontFamily, Arial, sans-serif); padding: 0; margin: 0; }
  ui5-card { width: 100%; box-sizing: border-box; }
  ui5-table { width: 100%; }
  .toolbar { padding: 6px 12px; display:flex; gap:8px; align-items:center; }
  .muted { color: var(--sapContent_LabelColor, #556b82); font-size: 12px; }
  .grow { flex: 1; }
</style>
<div class="card-shell">
  <ui5-card>
    <ui5-card-header slot="header" title-text="Excel – Vorschau" subtitle-text="${fileName}"></ui5-card-header>
    <div class="toolbar">
      <span class="muted">Reiter wechseln, um Blätter zu sehen</span>
      <span class="grow"></span>
      ${clientModel.downloadUrl ? `<ui5-button id="btnDownload" design="Transparent" icon="download">Download</ui5-button>` : ''}
    </div>
    <ui5-tabcontainer id="tabs" tab-layout="Inline" tabs-overflow-mode="End"></ui5-tabcontainer>
  </ui5-card>
  <script>
    // Minimal process shim before module imports (prevents "process is not defined")
    (function(){ try { if (!window.process) { window.process = { env: {} }; } } catch(e) {} })();
  </script>
  <script type="module">
    import 'https://esm.sh/@ui5/webcomponents@1.24.0/dist/Assets.js';
    import 'https://esm.sh/@ui5/webcomponents@1.24.0/dist/Card.js';
    import 'https://esm.sh/@ui5/webcomponents@1.24.0/dist/CardHeader.js';
    import 'https://esm.sh/@ui5/webcomponents@1.24.0/dist/Tab.js';
    import 'https://esm.sh/@ui5/webcomponents@1.24.0/dist/Table.js';
    import 'https://esm.sh/@ui5/webcomponents@1.24.0/dist/TableRow.js';
    import 'https://esm.sh/@ui5/webcomponents@1.24.0/dist/TableCell.js';
    import 'https://esm.sh/@ui5/webcomponents@1.24.0/dist/TableColumn.js';
    import 'https://esm.sh/@ui5/webcomponents@1.24.0/dist/Label.js';
    // Icons collection loader (needed for button icons like "download")
    import 'https://esm.sh/@ui5/webcomponents-icons@1.24.0/dist/AllIcons.js';

    const model = ${JSON.stringify(clientModel)};

    function parseHtmlTable(html) {
      try {
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const table = doc.querySelector('table');
        if (!table) return { headers: [], rows: [] };
        const rows = Array.from(table.querySelectorAll('tr'));
        if (!rows.length) return { headers: [], rows: [] };
        // Find first non-empty row as header
        let headerCells = Array.from(rows[0].querySelectorAll('th,td')).map((c) => c.textContent?.trim() || '').filter(Boolean);
        let dataStart = 1;
        if (headerCells.length === 0 && rows.length > 1) {
          headerCells = Array.from(rows[1].querySelectorAll('th,td')).map((c) => c.textContent?.trim() || '').filter(Boolean);
          dataStart = 2;
        }
        const bodyRows = [];
        for (let i = dataStart; i < rows.length; i++) {
          const cols = Array.from(rows[i].querySelectorAll('td')).map((c) => (c.textContent || '').trim());
          if (cols.length) bodyRows.push(cols);
        }
        return { headers: headerCells, rows: bodyRows };
      } catch (_) {
        return { headers: [], rows: [] };
      }
    }

    function buildTable(sheet) {
      const { headers, rows } = parseHtmlTable(sheet.rawHtml);
      const limit = Math.max(1, Math.min(${maxRows}, rows.length));
      const table = document.createElement('ui5-table');
      const effectiveHeaders = (headers && headers.length) ? headers : Array.from({ length: (rows[0] || []).length }, (_, i) => ('Col ' + (i + 1)));

      // Create columns with header slot labels
      effectiveHeaders.forEach(h => {
        const col = document.createElement('ui5-table-column');
        const hl = document.createElement('ui5-label');
        hl.setAttribute('slot', 'header');
        hl.textContent = h || '';
        col.appendChild(hl);
        table.appendChild(col);
      });

      // Append rows
      for (let i = 0; i < limit; i++) {
        const r = rows[i] || [];
        const tr = document.createElement('ui5-table-row');
        for (let c = 0; c < effectiveHeaders.length; c++) {
          const tc = document.createElement('ui5-table-cell');
          const lb = document.createElement('ui5-label');
          lb.textContent = String(r[c] ?? '');
          tc.appendChild(lb);
          tr.appendChild(tc);
        }
        table.appendChild(tr);
      }
      return table;
    }

    function render() {
      const tabs = document.getElementById('tabs');
      if (!tabs) return;
      tabs.innerHTML = '';
      (model.sheets || []).forEach((s, idx) => {
        const tab = document.createElement('ui5-tab');
        tab.setAttribute('text', s.name || 'Sheet');
        const table = buildTable(s);
        tab.appendChild(table);
        if (idx === 0 && !tab.hasAttribute('selected')) {
          tab.setAttribute('selected', ''); // ensure the first tab is active by default
        }
        tabs.appendChild(tab);
      });
      // no further selection handling needed; ui5-tab[selected] takes precedence
    }

    render();

    const btn = document.getElementById('btnDownload');
    if (btn && model.downloadUrl) {
      btn.addEventListener('click', () => {
        try { window.open(model.downloadUrl, '_blank'); } catch (_) {}
      });
    }

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
            uri: `ui://excel/preview/${Date.now()}`,
            content: { type: 'rawHtml', htmlString: html },
            encoding: 'text',
            metadata: {
              title: 'Excel – Vorschau',
              'mcpui.dev/ui-preferred-frame-size': ['100%', '520px']
            }
          });

          return JSON.stringify({ status: 'ok', uiResource: ui.resource });
        }
      });
      allTools.push(excelPreviewTool);

      // Claims report card tool: renders a Chart.js visualization inside a UI5 Card
      const claimsReportCardTool = new DynamicStructuredTool({
        name: 'claims.report.card.compose',
        description:
          'Erzeugt eine UI5-Card mit einem Chart.js-Report auf Basis einer CAP-Entität (z. B. kfz.claims.Claims).',
        schema: z.object({
          prompt: z.string().min(1).describe('Freitext-Beschreibung der gewünschten Visualisierung.'),
          entity: z.string().optional().describe('CAP-Entität, Standard: kfz.claims.Claims.'),
          columns: z.array(z.string()).optional().describe('Liste von Spalten. Erste Textspalte wird als Label verwendet, übrige als Datensätze.'),
          chartType: z.enum(['bar', 'line', 'pie']).optional().describe('Diagrammtyp (Standard: bar).'),
          where: z.record(z.any()).optional().describe('Optionale Filterbedingung für die Abfrage.'),
          limit: z.number().int().min(1).max(500).optional().describe('Limit der Zeilen (Standard: 200).'),
          title: z.string().optional().describe('Titel der Karte.'),
          subtitle: z.string().optional().describe('Untertitel der Karte.'),
        }),
        func: async (input) => {
          const entity = (input.entity && input.entity.trim()) || 'kfz.claims.Claims';
          const chartType = (input.chartType as string) || 'bar';
          const limit = Number.isFinite(input.limit as number) ? Number(input.limit) : 200;
          const requestedCols = Array.isArray(input.columns) && input.columns.length ? input.columns : ['fraud_score', 'estimated_cost', 'description_short'];

          // Prefer description_short as label, then any *description* field, else fallback
          const preferLabelCandidates = ['description_short', 'short_description', 'description'];
          let labelField = requestedCols.find(c => preferLabelCandidates.includes(c))
            || requestedCols.find(c => /description/i.test(c))
            || 'description_short';
          if (!requestedCols.includes(labelField)) {
            requestedCols.push(labelField);
          }
          // Value fields = all except label. Fallback to fraud_score + estimated_cost
          let valueFields = requestedCols.filter(c => c !== labelField);
          if (!valueFields.length) {
            valueFields = ['fraud_score', 'estimated_cost'];
          }
          const columns = Array.from(new Set([labelField, ...valueFields]));

          // Read data via CAP MCP (active instances)
          const args: any = { entity, columns, limit, draft: 'active' };
          if (input.where && typeof input.where === 'object') {
            args.where = input.where;
          }
          const readOut = await clients.cap.callTool({ name: 'cap.cqn.read', arguments: args });
          // Coerce MCP tool output into JSON and extract rows
          const toText = (out: any): string => {
            if (!out) return '';
            const s = (out as any).structuredContent;
            if (typeof s === 'string') return s;
            if (Array.isArray(s)) return s.map((p) => (typeof p === 'string' ? p : (p?.text || ''))).join('\n');
            const c = (out as any).content;
            if (typeof c === 'string') return c;
            if (Array.isArray(c)) return c.map((p) => (typeof p === 'string' ? p : (p?.text || ''))).join('\n');
            if (typeof out === 'string') return out;
            if ((out as any)?.text) return String((out as any).text);
            try { return JSON.stringify(out); } catch { return String(out); }
          };
          const coerceRows = (out: any): any[] => {
            if (!out) return [];
            if (Array.isArray((out as any).rows)) return (out as any).rows as any[];
            if (Array.isArray(out)) return out as any[];
            // try parse stringified JSON in content/text
            const txt = toText(out).trim();
            if (txt) {
              try {
                const j = JSON.parse(txt);
                if (Array.isArray((j as any).rows)) return (j as any).rows as any[];
                if (Array.isArray(j)) return j as any[];
              } catch { /* not JSON */ }
            }
            return [];
          };
          const rows: any[] = coerceRows(readOut);

          const labels = rows.map(r => String((r && r[labelField]) ?? ''));
          const series = valueFields.map((vf) => ({
            field: vf,
            data: rows.map(r => {
              const v = (r && r[vf]) as any;
              const n = typeof v === 'number' ? v : parseFloat(String(v ?? '0').replace(',', '.'));
              return Number.isFinite(n) ? n : 0;
            }),
          }));

          const palette = [
            ['rgba(54, 162, 235, 0.7)', 'rgba(54, 162, 235, 1)'],
            ['rgba(255, 99, 132, 0.7)', 'rgba(255, 99, 132, 1)'],
            ['rgba(255, 206, 86, 0.7)', 'rgba(255, 206, 86, 1)'],
            ['rgba(75, 192, 192, 0.7)', 'rgba(75, 192, 192, 1)'],
            ['rgba(153, 102, 255, 0.7)', 'rgba(153, 102, 255, 1)'],
            ['rgba(255, 159, 64, 0.7)', 'rgba(255, 159, 64, 1)'],
          ];

          const jsDatasets = series.map((s, i) => {
            const [bg, border] = palette[i % palette.length];
            return {
              label: s.field,
              data: s.data,
              backgroundColor: bg,
              borderColor: border,
              borderWidth: 1,
            };
          });

          const datasetsForType = chartType === 'pie' && jsDatasets.length > 1 ? [jsDatasets[0]] : jsDatasets;

          const cardTitle = (input.title && input.title.trim()) || 'Schadenfälle – Report';
          const cardSubtitle = (input.subtitle && input.subtitle.trim()) || (input.prompt || '').slice(0, 120);

          const html = `
          <style>
            html, body { margin: 0; padding: 0; background: transparent; overflow: hidden; }
            .card-shell { font-family: Arial, sans-serif; padding: 0; margin: 0; }
            ui5-card { width: 100%; }
            #chartWrap { padding: 8px 12px 16px; }
            #chart { width: 100%; height: 360px; }
          </style>
          <div class="card-shell">
            <ui5-card>
              <ui5-card-header slot="header" title-text="${cardTitle.replace(/\"/g, '&quot;')}" subtitle-text="${(cardSubtitle || '').replace(/\"/g, '&quot;')}"></ui5-card-header>
              <div id="chartWrap">
                <canvas id="chart"></canvas>
              </div>
            </ui5-card>

            <script>
              // Minimal process shim to avoid "process is not defined" in UI5 ESM bundles
              (function(){ try { if (!window.process) { window.process = { env: {} }; } } catch(e) {} })();
            </script>
            <script type="module">
              import 'https://esm.sh/@ui5/webcomponents@1.24.0/dist/Assets.js';
              import 'https://esm.sh/@ui5/webcomponents@1.24.0/dist/Card.js';
              import 'https://esm.sh/@ui5/webcomponents@1.24.0/dist/CardHeader.js';
              import 'https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js';

              const labels = ${JSON.stringify(labels)};
              const datasets = ${JSON.stringify(datasetsForType)};
              const type = ${JSON.stringify(chartType)};

              const ctx = document.getElementById('chart').getContext('2d');
              const config = {
                type,
                data: { labels, datasets },
                options: {
                  responsive: true,
                  maintainAspectRatio: false,
                  plugins: { legend: { position: 'top' }, tooltip: { mode: 'index', intersect: false } },
                  scales: (type === 'bar' || type === 'line') ? {
                    x: { ticks: { autoSkip: true, maxRotation: 0, minRotation: 0 } },
                    y: { beginAtZero: true },
                  } : undefined,
                }
              };
              new window.Chart(ctx, config);

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
            uri: `ui://claims/report/${Date.now()}`,
            content: { type: 'rawHtml', htmlString: html },
            encoding: 'text',
            metadata: { title: cardTitle, 'mcpui.dev/ui-preferred-frame-size': ['100%', '460px'] },
          });

          return JSON.stringify({ status: 'ok', uiResource: ui.resource });
        },
      });
      allTools.push(claimsReportCardTool);

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
