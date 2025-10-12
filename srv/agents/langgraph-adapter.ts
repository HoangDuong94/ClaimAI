import path from 'node:path';
import { loadMcpTools } from '@langchain/mcp-adapters';
import { createReactAgent } from '@langchain/langgraph/prebuilt';
import { StateGraph, MessagesAnnotation, Command, START } from '@langchain/langgraph';
import { AzureOpenAiChatClient } from '@sap-ai-sdk/langchain';
import { MemorySaver } from '@langchain/langgraph-checkpoint';
import { DynamicStructuredTool } from '@langchain/core/tools';
import type { StructuredToolInterface } from '@langchain/core/tools';
import type { RunnableConfig } from '@langchain/core/runnables';
import type { BaseMessage } from '@langchain/core/messages';
import { AIMessage, HumanMessage, SystemMessage, isAIMessage } from '@langchain/core/messages';
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

const parsePositiveInteger = (value: string | undefined, fallback: number): number => {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
};

const DEFAULT_MAX_HOPS = 6;

const TRIAGE_KEYWORDS = /\b(mail|e-?mail|posteingang|inbox|anhang|attachment|outlook|teams)\b/i;

const ALLOWED_GENERAL_TOOLS = new Set([
  'cap.cqn.read',
  'cap.claims.list_summary',
  'reporting.list_reports',
  'fs.write_report_html',
]);

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

const SUPERVISOR_PROMPT = [
  'Du bist der ClaimAI Supervisor. Entscheide, welcher Spezialagent als nächstes aktiv werden soll.',
  'Verfügbare Agenten:',
  '- triage_agent: Microsoft 365 Posteingang, Anhänge, Mail-Triage.',
  '- claims_data_agent: CAP-Schadenfalldaten abrufen, tabellarische Übersichten.',
  '- report_agent: Analysen, Visualisierungen und Dateien schreiben oder aktualisieren.',
  '- general_agent: Abschlussantwort für den Nutzer verfassen, Ergebnisse zusammenfassen.',
  'Antworte ausschließlich mit gültigem JSON der Form {"next":"<agent>","instructions":"<kurzer Hinweis>","reason":"<Begründung>"}',
  '"next" muss einer der Werte ["triage_agent","claims_data_agent","report_agent","general_agent","end"] sein.',
  'Nutze "instructions" nur für kurze Hinweise (max. 120 Zeichen); sonst leere Zeichenkette.',
  'Setze "next" auf "report_agent" für Analysen/Reports, auf "claims_data_agent" für Datenauswertungen.',
  'Stelle sicher, dass "general_agent" am Ende ausgeführt wird, damit eine Nutzerantwort entsteht.',
  'Verwende "end" nur, wenn keine weitere Antwort nötig ist.',
].join('\n');

const SUPERVISOR_MODEL_NAME =
  (process.env.CLAIMAI_SUPERVISOR_MODEL && process.env.CLAIMAI_SUPERVISOR_MODEL.trim()) || 'gpt-4.1';

type SupervisorNextAgent = 'triage_agent' | 'claims_data_agent' | 'report_agent' | 'general_agent' | 'end';

interface SupervisorDecision {
  next: SupervisorNextAgent;
  instructions?: string | null;
  reason?: string | null;
}

const stripCodeFences = (raw: string): string => {
  const trimmed = raw.trim();
  if (trimmed.startsWith('```')) {
    const withoutOpening = trimmed.replace(/^```[a-zA-Z]*\s*/, '');
    const closingIndex = withoutOpening.lastIndexOf('```');
    if (closingIndex >= 0) {
      return withoutOpening.slice(0, closingIndex).trim();
    }
    return withoutOpening.trim();
  }
  return trimmed;
};

const parseSupervisorDecision = (raw: string): SupervisorDecision | null => {
  if (!raw) return null;
  const cleaned = stripCodeFences(raw);
  try {
    const parsed = JSON.parse(cleaned) as SupervisorDecision;
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }
    const next = (parsed as { next?: unknown }).next;
    if (
      next !== 'triage_agent' &&
      next !== 'claims_data_agent' &&
      next !== 'report_agent' &&
      next !== 'general_agent' &&
      next !== 'end'
    ) {
      return null;
    }
    const instructionsRaw = (parsed as { instructions?: unknown }).instructions;
    const reasonRaw = (parsed as { reason?: unknown }).reason;
    return {
      next,
      instructions:
        typeof instructionsRaw === 'string' && instructionsRaw.trim().length
          ? instructionsRaw.trim()
          : null,
      reason:
        typeof reasonRaw === 'string' && reasonRaw.trim().length ? reasonRaw.trim() : null,
    };
  } catch {
    return null;
  }
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

const normalizeWhitespace = (text: string): string => text.replace(/\s+/g, ' ').trim();

const stripHtml = (html: string): string =>
  html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ');

const extractReportLabel = (html: string): string => {
  if (!html) {
    return 'Analyse';
  }
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleMatch && normalizeWhitespace(titleMatch[1])) {
    return normalizeWhitespace(titleMatch[1]).slice(0, 120);
  }
  const headingMatch = html.match(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/i);
  if (headingMatch && normalizeWhitespace(headingMatch[1])) {
    return normalizeWhitespace(headingMatch[1]).slice(0, 120);
  }
  const fallback = normalizeWhitespace(stripHtml(html));
  return fallback ? fallback.slice(0, 120) : 'Analyse';
};

const extractTextSnippet = (html: string, maxLength = 200): string => {
  if (!html) return '';
  const plain = normalizeWhitespace(stripHtml(html));
  if (!plain) return '';
  if (plain.length <= maxLength) return plain;
  return `${plain.slice(0, Math.max(0, maxLength - 1))}…`;
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
      const conversationKey =
        typeof conversationId === 'string' && conversationId.trim().length
          ? conversationId.trim()
          : `session_${userId || 'default'}`;
      const threadId = conversationKey;

      this.logger.log('\n\n---- AGENT INVOKE START ----\n');

      this.logger.log(
        `[Agent] conversation=${conversationKey} thread=${threadId} user="${normalizeWhitespace(prompt).slice(0, 120)}"`,
      );

      const result = await executor.invoke(
        {
          messages: [
            {
              role: 'user',
              content: prompt,
            },
          ],
        },
        {
          configurable: {
            thread_id: threadId,
            conversation_id: conversationKey,
          },
        },
      );

      const messages = Array.isArray(result.messages) ? (result.messages as BaseMessage[]) : [];
      const aiMessages = messages.filter((message) => message.getType?.() === 'ai');
      const aiTexts = aiMessages
        .map((message) => extractMessageText(message))
        .filter((text) => text.trim().length > 0);
      const aiTimeline = aiMessages.map((message, index) => {
        const name = isAIMessage(message) && message.name ? message.name : `ai#${index + 1}`;
        const text = normalizeWhitespace(extractMessageText(message)).slice(0, 160);
        return `${name}: ${text}`;
      });
      this.logger.log('Agent timeline:', aiTimeline);
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
    const maxHops = parsePositiveInteger(process.env.CLAIMAI_MAX_HOPS, DEFAULT_MAX_HOPS);
    const supervisorDisabled = isTruthy(process.env.CLAIMAI_DISABLE_SUPERVISOR);

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

      const reportingState = {
        allowedRoots: null as string[] | null,
        createdDirectories: new Set<string>(),
        writtenFiles: new Map<
          string,
          { content: string; updatedAt: number; label: string }
        >(),
        reportHistory: [] as Array<{ path: string; label: string; updatedAt: number }>,
      };

      const recordReportMetadata = (filePath: string, content: string): void => {
        const label = extractReportLabel(content);
        const updatedAt = Date.now();
        reportingState.writtenFiles.set(filePath, { content, updatedAt, label });
        const existingIndex = reportingState.reportHistory.findIndex(
          (entry) => entry.path === filePath,
        );
        const entry = { path: filePath, label, updatedAt };
        if (existingIndex >= 0) {
          reportingState.reportHistory[existingIndex] = entry;
        } else {
          reportingState.reportHistory.push(entry);
        }
        reportingState.reportHistory.sort((a, b) => b.updatedAt - a.updatedAt);
        if (reportingState.reportHistory.length > 50) {
          reportingState.reportHistory.length = 50;
        }
      };

      const filesystemClient = clients.filesystem;
      if (!filesystemClient) {
        throw new Error('Filesystem MCP client ist nicht verfügbar.');
      }

      const toErrorMessage = (error: unknown): string =>
        error instanceof Error ? error.message : String(error);

      const ensureAllowedRoots = async (): Promise<string[]> => {
        if (reportingState.allowedRoots) {
          return reportingState.allowedRoots;
        }
        const result = await filesystemClient.callTool({
          name: 'list_allowed_directories',
          arguments: {},
        });
        const serialized = stringifyToolResult(result);
        const lines = serialized
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => line.length > 0);
        if (!lines.length) {
          throw new Error('Keine erlaubten Verzeichnisse gefunden.');
        }
        const normalized = lines.map((entry) => path.normalize(entry));
        reportingState.allowedRoots = normalized;
        normalized.forEach((entry) => reportingState.createdDirectories.add(entry));
        return normalized;
      };

      const resolvePathWithinRoots = async (
        rawPath: string,
      ): Promise<{ normalized: string; roots: string[] }> => {
        if (typeof rawPath !== 'string') {
          throw new Error('Pfad muss als String übergeben werden.');
        }
        const trimmed = rawPath.trim();
        if (!trimmed) {
          throw new Error('Pfad darf nicht leer sein.');
        }
        const roots = await ensureAllowedRoots();
        const baseRoot = roots[0];
        const baseNormalized = path.normalize(baseRoot);
        const candidate = path.isAbsolute(trimmed)
          ? path.normalize(trimmed)
          : path.normalize(path.join(baseNormalized, trimmed));
        const isInside = roots.some((root) => {
          const normalizedRoot = path.normalize(root);
          if (candidate === normalizedRoot) return true;
          const withSep = normalizedRoot.endsWith(path.sep) ? normalizedRoot : `${normalizedRoot}${path.sep}`;
          return candidate.startsWith(withSep);
        });
        if (!isInside) {
          throw new Error(
            `Pfad "${candidate}" liegt außerhalb der erlaubten Verzeichnisse: ${roots.join(', ')}`,
          );
        }
        return { normalized: candidate, roots };
      };

      const ensureDirectoryInternal = async (rawDirPath: string): Promise<string> => {
        const { normalized } = await resolvePathWithinRoots(rawDirPath);
        if (reportingState.createdDirectories.has(normalized)) {
          return normalized;
        }
        try {
          await filesystemClient.callTool({
            name: 'create_directory',
            arguments: { path: normalized },
          });
        } catch (error) {
          const message = toErrorMessage(error);
          if (!/already exists/i.test(message)) {
            throw error;
          }
        }
        reportingState.createdDirectories.add(normalized);
        return normalized;
      };

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

      const listAllowedDirectoriesTool = new DynamicStructuredTool({
        name: 'fs.list_allowed_directories',
        description:
          'Listet die erlaubten Sandbox-Wurzeln (gecached, um mehrfachen Aufruf zu vermeiden).',
        schema: z.object({}).passthrough(),
        func: async () => {
          const roots = await ensureAllowedRoots();
          return roots.join('\n');
        },
      });

      const ensureDirectoryTool = new DynamicStructuredTool({
        name: 'fs.ensure_directory',
        description:
          'Legt ein Verzeichnis innerhalb der erlaubten Sandbox an (idempotent, nutzt Cache).',
        schema: z
          .object({
            path: z.string().trim().min(1, 'Pfad ist erforderlich.'),
          })
          .passthrough(),
        func: async (input) => {
          const target = typeof input?.path === 'string' ? input.path : '';
          const { normalized } = await resolvePathWithinRoots(target);
          if (reportingState.createdDirectories.has(normalized)) {
            return `Directory already prepared: ${normalized}`;
          }
          try {
            const result = await filesystemClient.callTool({
              name: 'create_directory',
              arguments: { path: normalized },
            });
            reportingState.createdDirectories.add(normalized);
            return stringifyToolResult(result);
          } catch (error) {
            const message = toErrorMessage(error);
            if (/already exists/i.test(message)) {
              reportingState.createdDirectories.add(normalized);
              return `Directory already existed: ${normalized}`;
            }
            throw error;
          }
        },
      });

      const writeReportTool = new DynamicStructuredTool({
        name: 'fs.write_report_html',
        description:
          'Schreibt eine HTML-/Textdatei im erlaubten Verzeichnis (idempotent, cached Inhalt).',
        schema: z
          .object({
            path: z.string().trim().min(1, 'Pfad ist erforderlich.'),
            content: z.string().min(1, 'content darf nicht leer sein.'),
            encoding: z.string().trim().optional(),
          })
          .passthrough(),
        func: async (input) => {
          const targetPath = typeof input?.path === 'string' ? input.path : '';
          const content = typeof input?.content === 'string' ? input.content : '';
          if (!content.trim()) {
            throw new Error('content darf nicht leer sein.');
          }
          const { normalized } = await resolvePathWithinRoots(targetPath);
          const directory = path.dirname(normalized);
          await ensureDirectoryInternal(directory);
          const cached = reportingState.writtenFiles.get(normalized);
          if (cached?.content === content) {
            recordReportMetadata(normalized, content);
            return `Skipped write (content unchanged): ${normalized}`;
          }
          const args: Record<string, unknown> = {
            path: normalized,
            content,
          };
          if (typeof input?.encoding === 'string' && input.encoding.trim()) {
            args.encoding = input.encoding.trim();
          }
          const result = await filesystemClient.callTool({
            name: 'write_file',
            arguments: args,
          });
          recordReportMetadata(normalized, content);
          return stringifyToolResult(result);
        },
      });

      const listReportsTool = new DynamicStructuredTool({
        name: 'reporting.list_reports',
        description:
          'Listet die zuletzt generierten Analysen (neuste zuerst). Optional mit Vorschau.',
        schema: z
          .object({
            limit: z
              .number()
              .int()
              .min(1, 'limit muss mindestens 1 sein.')
              .max(20, 'limit darf höchstens 20 sein.')
              .optional(),
            includePreview: z.boolean().optional(),
          })
          .passthrough(),
        func: async (input) => {
          if (!reportingState.reportHistory.length) {
            return 'Es liegen keine gespeicherten Analysen aus dieser Sitzung vor.';
          }
          const rawLimit = typeof input?.limit === 'number' && Number.isFinite(input.limit)
            ? Math.trunc(input.limit)
            : 5;
          const limit = Math.min(20, Math.max(1, rawLimit));
          const includePreview = Boolean(input?.includePreview);
          const entries = reportingState.reportHistory.slice(0, limit);
          const lines = entries.map((entry, index) => {
            const idx = index + 1;
            const timestamp = new Date(entry.updatedAt);
            const formatted = Number.isNaN(timestamp.getTime())
              ? 'Zeitpunkt unbekannt'
              : timestamp.toLocaleString('de-CH');
            let preview = '';
            if (includePreview) {
              const meta = reportingState.writtenFiles.get(entry.path);
              if (meta) {
                const snippet = extractTextSnippet(meta.content, 200);
                if (snippet) {
                  preview = `\n    Vorschau: ${snippet}`;
                }
              }
            }
            return `${idx}. ${entry.label} — ${entry.path} (${formatted})${preview}`;
          });
          return lines.join('\n');
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
        listAllowedDirectoriesTool,
        ensureDirectoryTool,
        writeReportTool,
        listReportsTool,
        ...excelTools,
        ...timeTools,
      ];

      const reportingTools: StructuredToolInterface[] = [
        listAllowedDirectoriesTool,
        ensureDirectoryTool,
        writeReportTool,
        listReportsTool,
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
      const supervisorModel = new AzureOpenAiChatClient({
        modelName: SUPERVISOR_MODEL_NAME,
        temperature: 0,
      });
      const checkpointer = new MemorySaver();

      const triageTools: StructuredToolInterface[] = mailTriageTool ? [mailTriageTool] : [];
      const claimsDataTools: StructuredToolInterface[] = [cachedSearchModelTool, claimsListSummaryTool];
      const reportTools: StructuredToolInterface[] = [
        cachedSearchModelTool,
        claimsListSummaryTool,
        ...reportingTools,
      ];
      const capReadTool = capTools.find((tool) => tool.name === 'cap.cqn.read');
      if (capReadTool) {
        claimsDataTools.push(capReadTool);
        reportTools.push(capReadTool);
      }
      const baseGeneralTools = allTools.filter((tool) => tool !== mailTriageTool);
      const generalToolsSlim = baseGeneralTools.filter((tool) => ALLOWED_GENERAL_TOOLS.has(tool.name));
      if (!generalToolsSlim.length) {
        this.logger.debug?.(
          'General-Agent verwendet vollständige Tool-Liste (keine Übereinstimmung mit whitelist).',
        );
      }
      const generalAgentTools = generalToolsSlim.length ? generalToolsSlim : baseGeneralTools;

      const generalAgent = createReactAgent({
        llm,
        tools: generalAgentTools,
        stateModifier: new SystemMessage(
          'Du bist der ClaimAI Hauptexperte. Fasse Beiträge der Sub-Agenten zusammen, setze bei Bedarf eigene Tools ein und liefere eine kurze, handlungsorientierte Antwort mit klaren Empfehlungen.',
        ),
        checkpointSaver: checkpointer,
      });

      if (supervisorDisabled) {
        this.logger.log('Single-Agent-Modus aktiviert (Supervisor deaktiviert).');
        this.agentExecutor = generalAgent;
        return this.agentExecutor;
      }

      if (triageTools.length === 0 && claimsDataTools.length === 0) {
        this.logger.log('⚠️ Kein dediziertes CAP-Triage-Tool gefunden – falle auf Single-Agent zurück.');
        this.agentExecutor = generalAgent;
        return this.agentExecutor;
      }

      const triageAgent = createReactAgent({
        llm,
        tools: triageTools,
        stateModifier: new SystemMessage(
          'Du bist der ClaimAI Triage-Agent. Nutze die M365-Triage-Tools, fasse den neuesten Posteingang kurz zusammen (Inhalt, Priorität, Anhänge) und melde Fehler oder leere Ergebnisse knapp zurück.',
        ),
        checkpointSaver: checkpointer,
      });

      const claimsDataAgent = createReactAgent({
        llm,
        tools: claimsDataTools,
        stateModifier: new SystemMessage(
          'Du bist der ClaimAI Daten-Agent. HoIe bei Bedarf zuerst `search_model`, lies anschließend Claims-Daten (z. B. über `cap.claims.list_summary`) und gib eine kurze, strukturierte Markdown-Zusammenfassung der wichtigsten Kennzahlen.',
        ),
        checkpointSaver: checkpointer,
      });

      const reportAgent = createReactAgent({
        llm,
        tools: reportTools,
        stateModifier: new SystemMessage(
          'Du bist der ClaimAI Reporting-Agent. Hole bei Bedarf Metadaten, lies die nötigen CAP-Daten und aktualisiere eine HTML- oder Markdown-Analyse. Achte darauf, nur innerhalb der erlaubten Verzeichnisse zu schreiben und nenne am Ende den Speicherpfad plus wichtigste Befunde.',
        ),
        checkpointSaver: checkpointer,
      });

      const timedNodeInvoke = async (
        agent: AgentExecutor,
        name: string,
        nodeState: typeof MessagesAnnotation.State,
        runnableConfig?: RunnableConfig,
      ) => {
        const startedAt = Date.now();
        const result = await agent.invoke(nodeState, runnableConfig);
        const elapsed = Date.now() - startedAt;
        this.logger.log(`[Node] ${name} finished in ${elapsed} ms`);
        return result;
      };

      const supervisorNode = async (
        state: typeof MessagesAnnotation.State,
        config?: RunnableConfig,
      ): Promise<Command> => {
        const messages = state.messages ?? [];
        let lastHumanIndex = -1;
        for (let index = messages.length - 1; index >= 0; index -= 1) {
          const entry = messages[index];
          if (entry?.getType && entry.getType() === 'human') {
            lastHumanIndex = index;
            break;
          }
        }
        const lastUserMessage =
          lastHumanIndex >= 0 ? (messages[lastHumanIndex] as BaseMessage | undefined) : undefined;
        const lastUserText = normalizeWhitespace(extractMessageText(lastUserMessage));
        const aiAfterLastHuman = messages.filter(
          (message, index): message is AIMessage =>
            index > lastHumanIndex && message.getType?.() === 'ai' && isAIMessage(message),
        );
        const agentNames = aiAfterLastHuman
          .map((message) => message.name)
          .filter((name): name is string => typeof name === 'string' && name.trim().length > 0);
        const seenAgents = new Set(agentNames);
        const done = {
          triage: seenAgents.has('triage_agent'),
          claims: seenAgents.has('claims_data_agent'),
          report: seenAgents.has('report_agent'),
          general: seenAgents.has('general_agent'),
        };
        const hopCount = agentNames.filter((name) => /_agent$/.test(name)).length;
        if (hopCount >= maxHops && !done.general) {
          this.logger.log(
            `[Supervisor] Hop-Limit erreicht (${hopCount}/${maxHops}) – wechsle zu general_agent.`,
          );
          return new Command({ goto: 'general_agent' });
        }

        const recentAgentContext = aiAfterLastHuman
          .slice(-4)
          .map((message) => {
            const agentName = message.name ?? message.getType?.() ?? 'ai';
            const text = normalizeWhitespace(extractMessageText(message)).slice(0, 160);
            return text ? `${agentName}: ${text}` : `${agentName}: (keine Ausgabe)`;
          })
          .join('\n');

        let decision: SupervisorDecision | null = null;
        try {
          const supervisorMessages = [
            new SystemMessage(SUPERVISOR_PROMPT),
            new HumanMessage(
              [
                `Letzte Nutzeranfrage: ${lastUserText || '(leer)'}`,
                recentAgentContext
                  ? `Bisherige Agentenantworten:\n${recentAgentContext}`
                  : 'Keine relevanten Agentenantworten zuvor.',
              ].join('\n'),
            ),
          ];
          const response = await supervisorModel.invoke(supervisorMessages, config);
          const decisionText = extractMessageText(response as BaseMessage);
          decision = parseSupervisorDecision(decisionText);
          if (!decision) {
            this.logger.warn?.(
              `[Supervisor] Entscheidung nicht parsebar, fallback auf general_agent. Antwort: ${decisionText}`,
            );
          }
        } catch (error) {
          this.logger.error?.('[Supervisor] Entscheidung fehlgeschlagen, fallback auf general_agent.', error);
        }

        if (!decision) {
          if (done.general) {
            return new Command({ goto: '__end__' });
          }
          return new Command({ goto: 'general_agent' });
        }

        const trimmedInstructions =
          typeof decision.instructions === 'string'
            ? normalizeWhitespace(decision.instructions).slice(0, 160)
            : '';

        const mayTriage = TRIAGE_KEYWORDS.test(lastUserText);
        let next = decision.next;

        if (next === 'triage_agent' && (!mayTriage || done.triage)) {
          next = !done.claims ? 'claims_data_agent' : !done.report ? 'report_agent' : 'general_agent';
        }
        if (next === 'claims_data_agent' && done.claims) {
          next = !done.report ? 'report_agent' : 'general_agent';
        }
        if (next === 'report_agent' && done.report) {
          next = 'general_agent';
        }

        if (next === 'end' || (next === 'general_agent' && done.general)) {
          return new Command({ goto: '__end__' });
        }

        this.logger.debug?.(
          `[Supervisor] next=${decision.next} normalized=${next} instructions="${trimmedInstructions}" reason="${
            decision.reason ?? ''
          }"`,
        );

        const updates: SystemMessage[] = [];
        if (trimmedInstructions) {
          updates.push(new SystemMessage(`Supervisor-Anweisung: ${trimmedInstructions}`));
        }

        return new Command({
          goto: next,
          update: updates.length ? { messages: updates } : undefined,
        });
      };

      const triageNode = async (
        state: typeof MessagesAnnotation.State,
        config?: RunnableConfig,
      ): Promise<Command> => {
        const result = await timedNodeInvoke(triageAgent, 'triage_agent', state, config);
        const lastMessage = result.messages[result.messages.length - 1];
        const updates: AIMessage[] = [];
        if (lastMessage && isAIMessage(lastMessage)) {
          lastMessage.name = 'triage_agent';
          updates.push(lastMessage);
        }
        return new Command({
          goto: 'supervisor',
          update: updates.length ? { messages: updates } : undefined,
        });
      };

      const generalNode = async (
        state: typeof MessagesAnnotation.State,
        config?: RunnableConfig,
      ): Promise<Command> => {
        const result = await timedNodeInvoke(generalAgent, 'general_agent', state, config);
        const lastMessage = result.messages[result.messages.length - 1];
        const updates: AIMessage[] = [];
        if (lastMessage && isAIMessage(lastMessage)) {
          lastMessage.name = 'general_agent';
          updates.push(lastMessage);
        }
        return new Command({
          goto: '__end__',
          update: updates.length ? { messages: updates } : undefined,
        });
      };

      const claimsDataNode = async (
        state: typeof MessagesAnnotation.State,
        config?: RunnableConfig,
      ): Promise<Command> => {
        const result = await timedNodeInvoke(claimsDataAgent, 'claims_data_agent', state, config);
        const lastMessage = result.messages[result.messages.length - 1];
        const updates: AIMessage[] = [];
        if (lastMessage && isAIMessage(lastMessage)) {
          lastMessage.name = 'claims_data_agent';
          updates.push(lastMessage);
        }
        return new Command({
          goto: 'supervisor',
          update: updates.length ? { messages: updates } : undefined,
        });
      };

      const reportNode = async (
        state: typeof MessagesAnnotation.State,
        config?: RunnableConfig,
      ): Promise<Command> => {
        const result = await timedNodeInvoke(reportAgent, 'report_agent', state, config);
        const lastMessage = result.messages[result.messages.length - 1];
        const updates: AIMessage[] = [];
        if (lastMessage && isAIMessage(lastMessage)) {
          lastMessage.name = 'report_agent';
          updates.push(lastMessage);
        }
        return new Command({
          goto: 'supervisor',
          update: updates.length ? { messages: updates } : undefined,
        });
      };

      const graphBuilder = new StateGraph(MessagesAnnotation)
        .addNode('supervisor', supervisorNode, {
          ends: ['triage_agent', 'claims_data_agent', 'report_agent', 'general_agent', '__end__'],
        })
        .addNode('triage_agent', triageNode, { ends: ['supervisor'] })
        .addNode('claims_data_agent', claimsDataNode, { ends: ['supervisor'] })
        .addNode('report_agent', reportNode, { ends: ['supervisor'] })
        .addNode('general_agent', generalNode, { ends: ['__end__'] })
        .addEdge(START, 'supervisor');

      const compiledGraph = graphBuilder.compile({ checkpointer });
      this.agentExecutor = compiledGraph as unknown as AgentExecutor;

      this.logger.log(
        '✅ Multi-Agent LangGraph initialisiert (Supervisor + Triage-Agent + Claims-Data-Agent + Report-Agent + General-Agent).',
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
