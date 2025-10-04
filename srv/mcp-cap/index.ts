import cds from '@sap/cds';
import type { EventContext, Service, User } from '@sap/cds';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { JsonSchema } from '../m365-mcp/mcp-jsonschema.js';

type AnyRecord = Record<string, any>;

type LoggerLike = Console | { debug?: (...args: unknown[]) => void; log?: (...args: unknown[]) => void };

interface CapInitOptions {
  service: Service;
  logger?: LoggerLike;
}

interface ResolveDraftOptions {
  allowVirtual?: string[];
}

interface ServiceEntity {
  name: string;
  elements?: Record<string, EntityElement>;
  drafts?: ServiceEntity;
}

interface EntityElement {
  type?: string;
  virtual?: boolean;
  _target?: ServiceEntity;
}

interface DraftKey {
  ID?: string | number;
  DraftAdministrativeData_DraftUUID?: string;
  IsActiveEntity?: boolean;
  [key: string]: unknown;
}

interface DraftCacheEntry {
  keys: DraftKey;
  data: AnyRecord;
  timestamp: number;
}

interface DraftStore extends Map<string, DraftCacheEntry> {
  lastKey?: string;
}

interface ContextOverrides {
  event?: string;
  user?: User;
  tenant?: string;
  locale?: string;
  data?: AnyRecord;
  query?: AnyRecord;
  headers?: Record<string, string>;
}

type ServiceRequest = InstanceType<typeof cds.Request>;

type RequestContextState = ContextOverrides & { request?: ServiceRequest };

const MAX_ROWS = 200;

const DEFAULT_DRAFT_DATA: AnyRecord = {
  ort: 'Luzern',
  datum: null
};

// Lightweight in-memory cache that remembers the most recent drafts per entity.
const draftContext = new Map<string, DraftStore>();
const requestContextStorage = new AsyncLocalStorage<RequestContextState>();

const DEFAULT_DRAFT_ADMIN_COLUMNS = [
  'DraftUUID',
  'CreatedByUser',
  'LastChangedByUser',
  'InProcessByUser',
  'CreatedAt',
  'LastChangedAt'
];

const formatError = (error: unknown): string => {
  if (error instanceof Error && typeof error.message === 'string') {
    return error.message;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
};

function normalizePatchData(data: unknown): AnyRecord | null {
  if (data === null || data === undefined) {
    return null;
  }

  if (typeof data === 'string') {
    const trimmed = data.trim();
    if (!trimmed) {
      return null;
    }
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as AnyRecord;
      }
      throw new Error('Der Payload muss ein JSON-Objekt repräsentieren.');
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Daten-Payload konnte nicht geparst werden: ${reason}`);
    }
  }

  if (typeof data === 'object' && !Array.isArray(data)) {
    return data as AnyRecord;
  }

  throw new Error('cap.draft.patch erwartet ein Objekt als data-Payload.');
}

const toolDefinitions: Array<{ name: string; description: string; inputSchema: JsonSchema; metadata?: AnyRecord }> = [
  {
    name: 'cap.sql.execute',
    description: 'Execute a SQL statement through the CAP database connection. Defaults to read-only unless allowWrite is true.',
    inputSchema: {
      type: 'object',
      properties: {
        sql: { type: 'string', description: 'Complete SQL statement to execute.' },
        params: {
          description: 'Optional positional or named parameters passed to the statement.',
          anyOf: [
            { type: 'array', items: {} },
            { type: 'object', additionalProperties: true }
          ]
        },
        allowWrite: {
          type: 'boolean',
          description: 'Set to true to allow INSERT/UPDATE/DELETE/DDL statements.',
          default: false
        }
      },
      required: ['sql'],
      additionalProperties: false
    }
  },
  {
    name: 'cap.cqn.read',
    description: 'Run a CAP SELECT query using CQN primitives and return the resulting rows.',
    inputSchema: {
      type: 'object',
      properties: {
        entity: { type: 'string', description: 'Entity name as exposed by the service (for example kfz.claims.Claims).' },
        columns: { type: 'array', items: { type: 'string' }, description: 'Optional list of columns to project.' },
        where: { type: 'object', additionalProperties: true, description: 'Optional WHERE clause expressed as CQN object literal.' },
        limit: { type: 'integer', minimum: 1, description: 'Maximum number of rows to return.' },
        offset: { type: 'integer', minimum: 0, description: 'Offset for pagination.' },
        draft: { type: 'string', enum: ['merged', 'active', 'draft'], default: 'merged', description: 'Choose between merged (default), active-only, or draft-only records.' }
      },
      required: ['entity'],
      additionalProperties: false
    }
  },
  {
    name: 'cap.draft.new',
    description: 'Create a new draft instance for a draft-enabled entity.',
    inputSchema: {
      type: 'object',
      properties: {
        entity: { type: 'string', description: 'Draft-enabled entity name.' },
        data: { type: 'object', additionalProperties: true, description: 'Optional initial payload (default: Ort=Luzern, Datum=null).' }
      },
      required: ['entity'],
      additionalProperties: true
    }
  },
  {
    name: 'cap.draft.edit',
    description: 'Put an active instance into draft edit mode.',
    inputSchema: {
      type: 'object',
      properties: {
        entity: { type: 'string', description: 'Draft-enabled entity name.' },
        keys: { type: 'object', additionalProperties: true, description: 'Primary key identifying the active record. Optional if ein offener Draft existiert.' },
        ID: { type: 'string', description: 'Convenience field: ID der aktiven Instanz, falls keys fehlt.' }
      },
      required: ['entity'],
      additionalProperties: false
    }
  },
  {
    name: 'cap.draft.patch',
    description: 'Apply partial updates to an existing draft instance.',
    inputSchema: {
      type: 'object',
      properties: {
        entity: { type: 'string', description: 'Draft-enabled entity name.' },
        keys: { type: 'object', additionalProperties: true, description: 'Optional: Primärschlüssel (ID + DraftUUID). Wird automatisch ergänzt, wenn ein einzelner offener Draft existiert.' },
        data: { type: 'object', additionalProperties: true, description: 'Optional: Felder zum Aktualisieren.' },
        ID: { type: 'string', description: 'Convenience field: Draft-ID, falls keys fehlt.' },
        DraftAdministrativeData_DraftUUID: { type: 'string', description: 'Convenience field: DraftUUID, falls keys fehlt.' }
      },
      required: ['entity'],
      additionalProperties: true
    }
  },
  {
    name: 'cap.draft.save',
    description: 'Activate a draft and persist it as the active instance.',
    inputSchema: {
      type: 'object',
      properties: {
        entity: { type: 'string', description: 'Draft-enabled entity name.' },
        keys: { type: 'object', additionalProperties: true, description: 'Optional: Primärschlüssel (ID + DraftUUID). Wird automatisch ergänzt.' },
        ID: { type: 'string', description: 'Convenience: Draft-ID falls keys fehlt.' },
        DraftAdministrativeData_DraftUUID: { type: 'string', description: 'Convenience: DraftUUID falls keys fehlt.' }
      },
      required: ['entity'],
      additionalProperties: true
    }
  },
  {
    name: 'cap.draft.cancel',
    description: 'Discard an existing draft instance.',
    inputSchema: {
      type: 'object',
      properties: {
        entity: { type: 'string', description: 'Draft-enabled entity name.' },
        keys: { type: 'object', additionalProperties: true, description: 'Optional: Primärschlüssel (ID + DraftUUID). Wird automatisch ergänzt.' },
        ID: { type: 'string', description: 'Convenience: Draft-ID falls keys fehlt.' },
        DraftAdministrativeData_DraftUUID: { type: 'string', description: 'Convenience: DraftUUID falls keys fehlt.' }
      },
      required: ['entity'],
      additionalProperties: true
    }
  },
  {
    name: 'cap.draft.getAdminData',
    description: 'Read DraftAdministrativeData metadata for a draft-enabled entity.',
    inputSchema: {
      type: 'object',
      properties: {
        entity: { type: 'string', description: 'Draft-enabled entity name.' },
        keys: { type: 'object', additionalProperties: true, description: 'Optional: Primärschlüssel (ID + DraftUUID). Wird automatisch ergänzt.' },
        ID: { type: 'string', description: 'Convenience: Draft-ID falls keys fehlt.' },
        DraftAdministrativeData_DraftUUID: { type: 'string', description: 'Convenience: DraftUUID falls keys fehlt.' },
        columns: { type: 'array', items: { type: 'string' }, description: 'Optional Liste der gewünschten DraftAdmin-Felder.' }
      },
      required: ['entity'],
      additionalProperties: true
    }
  },
  {
    name: 'cap.draft.addChild',
    description: 'Append entries to a composition element of a draft-enabled root entity.',
    inputSchema: {
      type: 'object',
      properties: {
        entity: { type: 'string', description: 'Draft-enabled root entity name.' },
        child: { type: 'string', description: 'Name des Composition-Elements (z. B. "teilnehmer").' },
        entries: {
          type: 'array',
          items: { type: 'object', additionalProperties: true },
          description: 'Liste der zu ergänzenden Kind-Einträge.'
        },
        entry: { type: 'object', additionalProperties: true, description: 'Alternative zu entries: einzelner Kind-Eintrag.' },
        keys: { type: 'object', additionalProperties: true, description: 'Optional: Primärschlüssel (ID + DraftUUID).' },
        ID: { type: 'string', description: 'Convenience: Draft-ID falls keys fehlt.' },
        DraftAdministrativeData_DraftUUID: { type: 'string', description: 'Convenience: DraftUUID falls keys fehlt.' }
      },
      required: ['entity', 'child'],
      additionalProperties: true
    }
  }
];

export async function initCapMCPClient(options: CapInitOptions) {
  const { service, logger = console } = options;
  if (!service) {
    throw new Error('CAP MCP client requires a service instance. Pass { service } when initializing.');
  }

  const log = typeof logger?.debug === 'function' ? logger : console;
  log.debug?.('Initializing CAP MCP in-process client...');

  const db = await cds.connect.to('db');
  const privilegedUser: User = cds.User?.Privileged
    ? new (cds.User.Privileged as unknown as new (...args: any[]) => User)('mcp-cap')
    : ({ id: 'mcp-cap', roles: ['mcp.cap'], attr: {} } as User);

  function resolveEntity(entityName: string): ServiceEntity {
    if (!entityName) {
      throw new Error('Entity name must be a non-empty string');
    }
    const entities = (service.entities ?? {}) as Record<string, ServiceEntity>;
    const direct = entities[entityName];
    if (direct) {
      return direct;
    }
    const shortName = entityName.includes('.') ? entityName.split('.').pop() : undefined;
    if (shortName && entities[shortName]) {
      return entities[shortName];
    }
    const available = Object.keys(entities).join(', ') || '<none>';
    throw new Error(`Unknown entity "${entityName}". Available entities: ${available}`);
  }

  function getDraftStore(entityName: string): DraftStore {
    const key = entityName;
    if (!draftContext.has(key)) {
      draftContext.set(key, new Map() as DraftStore);
    }
    return draftContext.get(key)!;
  }

  function rememberDraft(entityRef: ServiceEntity, draftInstance: AnyRecord) {
    const draftUUID = draftInstance?.DraftAdministrativeData_DraftUUID || draftInstance?.draftAdministrativeData_DraftUUID;
    const id = draftInstance?.ID;
    if (!draftUUID || id === undefined || id === null) return;
    const store = getDraftStore(entityRef.name);
    const key = String(id);
    const keys: DraftKey = { ID: id, DraftAdministrativeData_DraftUUID: draftUUID, IsActiveEntity: false };
    store.set(key, { keys, data: draftInstance, timestamp: Date.now() });
    store.lastKey = key;
  }

  function forgetDraft(entityRef: ServiceEntity, keys: AnyRecord) {
    const store = getDraftStore(entityRef.name);
    const id = keys?.ID;
    const key = id === undefined || id === null ? undefined : String(id);
    if (key && store.has(key)) {
      store.delete(key);
    }
    if (store.lastKey === key) {
      store.lastKey = undefined;
    }
    if (store.size === 0) {
      draftContext.delete(entityRef.name);
    }
  }

  function hasProvidedDraftKeys(input: AnyRecord = {}) {
    if (!input || typeof input !== 'object') return false;
    if (input.keys && Object.keys(input.keys).length) return true;
    if (input.ID) return true;
    if (input.DraftAdministrativeData_DraftUUID) return true;
    return false;
  }

  function isMissingDraftError(error: unknown) {
    return (error as { message?: string })?.message?.includes('Kein passender Draft gefunden');
  }

  function resolveDraftKeys(entityRef: ServiceEntity, draftEntity: ServiceEntity, providedKeys: AnyRecord = {}, options: AnyRecord = {}) {
    const store = getDraftStore(entityRef.name);

    if (providedKeys && Object.keys(providedKeys).length) {
      const keys = { ...providedKeys };
      if (keys.DraftAdministrativeData_DraftUUID) {
        if (keys.IsActiveEntity === undefined) {
          keys.IsActiveEntity = false;
        }
        return keys;
      }
      if (keys.ID) {
        const cached = store.get(String(keys.ID));
        if (cached) {
          return { ...cached.keys, ...keys };
        }
        if (keys.IsActiveEntity !== undefined) {
          const { IsActiveEntity, ...rest } = keys;
          return { ID: keys.ID, ...rest, IsActiveEntity: Boolean(IsActiveEntity) };
        }
        return { ID: keys.ID, IsActiveEntity: false };
      } else if (keys.DraftAdministrativeData_DraftUUID) {
        for (const entry of store.values()) {
          if (entry.keys.DraftAdministrativeData_DraftUUID === keys.DraftAdministrativeData_DraftUUID) {
            return { ...entry.keys, ...keys, IsActiveEntity: false };
          }
        }
      }
      if (keys.IsActiveEntity !== undefined) {
        const { IsActiveEntity, ...rest } = keys;
        return { ...rest, IsActiveEntity: Boolean(IsActiveEntity) };
      }
    }

    const { ID, DraftAdministrativeData_DraftUUID, IsActiveEntity } = options;
    if (ID && DraftAdministrativeData_DraftUUID) {
      return {
        ID,
        DraftAdministrativeData_DraftUUID,
        IsActiveEntity: IsActiveEntity === undefined ? false : Boolean(IsActiveEntity)
      };
    }

    if (ID) {
      const cached = store.get(String(ID));
      if (cached) {
        return cached.keys;
      }
      return { ID, IsActiveEntity: false };
    }

    if (store.lastKey) {
      const cached = store.get(store.lastKey);
      if (cached) return cached.keys;
    }

    throw new Error(`Kein passender Draft gefunden. Bitte zuerst 'cap.draft.new' ausführen oder Keys (ID + DraftUUID) angeben.`);
  }

  function extractKeysAndData(entityRef: any, draftEntity: any, input: AnyRecord = {}) {
    const { keys: rawKeys, data: rawData, ...rest } = input;
    if (rest.entity !== undefined) delete rest.entity;
    const recognizedKeys = rawKeys ? { ...rawKeys } : {};
    const convenienceKeys: AnyRecord = {};

    if (rest.ID !== undefined) {
      convenienceKeys.ID = rest.ID;
      delete rest.ID;
    }
    if (rest.DraftAdministrativeData_DraftUUID !== undefined) {
      convenienceKeys.DraftAdministrativeData_DraftUUID = rest.DraftAdministrativeData_DraftUUID;
      delete rest.DraftAdministrativeData_DraftUUID;
    }

    const keys = Object.keys(recognizedKeys).length
      ? recognizedKeys
      : convenienceKeys;

    let data: any;
    if (rawData !== undefined) {
      data = rawData; // may be object or JSON string; normalize later
    } else {
      data = Object.keys(rest).length ? rest : null;
    }

    const resolvedKeys = resolveDraftKeys(entityRef, draftEntity, keys, convenienceKeys);

    return { keys: resolvedKeys, data };
  }

  function ensureDraftEntity(entity: any, originalName?: string) {
    if (!entity?.drafts) {
      const name = originalName || entity?.name || '<unknown>';
      throw new Error(`Entity "${name}" is not draft-enabled.`);
    }
    return entity.drafts;
  }

  async function withServiceContext<T>(fn: (req: ServiceRequest) => Promise<T> | T, overrides: ContextOverrides = {}): Promise<T> {
    const previous = cds.context as EventContext | undefined;
    const ambient = requestContextStorage.getStore() ?? {};
    const effectiveUser = overrides.user ?? ambient.user ?? previous?.user ?? privilegedUser;
    const effectiveTenant = overrides.tenant ?? ambient.tenant ?? previous?.tenant ?? (effectiveUser as User & { tenant?: string })?.tenant;
    const effectiveLocale = overrides.locale ?? ambient.locale ?? previous?.locale;

    const request = new cds.Request();
    Object.assign(request, {
      event: overrides.event ?? 'READ',
      user: effectiveUser,
      tenant: effectiveTenant,
      locale: effectiveLocale
    });

    try {
      cds.context = request;
      return await fn(request);
    } finally {
      cds.context = previous;
    }
  }

  function sanitizeDraftKeys(
    entity: any,
    keyValues: AnyRecord = {},
    options: ResolveDraftOptions & { dropKeys?: string[] } = {}
  ) {
    if (!keyValues || typeof keyValues !== 'object') {
      return {};
    }
    const { allowVirtual = [], dropKeys = [] } = options;
    const elements = entity?.elements || {};

    // Keep only primary-key elements plus explicitly allowed virtuals
    const primaryKeys = new Set<string>();
    for (const [name, element] of Object.entries(elements)) {
      // CAP marks key columns with element.key === true on projections/drafts
      if ((element as any)?.key === true) primaryKeys.add(name);
    }

    const cleaned: AnyRecord = {};
    for (const [key, value] of Object.entries(keyValues)) {
      if (dropKeys.includes(key)) continue;
      const element = (elements as any)[key];
      const isVirtual = Boolean(element?.virtual);
      const isAllowedVirtual = allowVirtual.includes(key);
      const isPrimaryKey = primaryKeys.has(key);
      if (!isPrimaryKey && !(isVirtual && isAllowedVirtual)) continue;
      if (value === undefined) continue;
      cleaned[key] = value;
    }
    return cleaned;
  }

  async function autoResolveDraftKeys(entityRef: any, draftEntity: any): Promise<AnyRecord | null> {
    const columns: AnyRecord[] = [];

    if (draftEntity.elements?.ID) {
      columns.push({ ref: ['ID'] });
    }
    if (draftEntity.elements?.DraftAdministrativeData_DraftUUID) {
      columns.push({ ref: ['DraftAdministrativeData_DraftUUID'] });
    }

    if (!columns.length) {
      return null;
    }

    const query = cds.ql.SELECT.one.from(draftEntity).columns(...columns);

    const orderCandidates = [
      ['modifiedAt', 'desc'],
      ['LastChangedAt', 'desc'],
      ['createdAt', 'desc'],
      ['CreationDateTime', 'desc']
    ];

    for (const [field, sort] of orderCandidates) {
      if (draftEntity.elements?.[field]) {
        // Use string form "field desc" to avoid interpreting 'desc' as a column name
        query.orderBy(`${field} ${sort}`);
        break;
      }
    }

    const latest = await withServiceContext(async () => service.run(query));
    if (!latest) {
      return null;
    }

    const autoKeys: DraftKey = {};
    if (latest.ID !== undefined) {
      autoKeys.ID = latest.ID;
    }
    if (latest.DraftAdministrativeData_DraftUUID !== undefined) {
      autoKeys.DraftAdministrativeData_DraftUUID = latest.DraftAdministrativeData_DraftUUID;
    }

    if (!Object.keys(autoKeys).length) {
      return null;
    }

    autoKeys.IsActiveEntity = false;

    rememberDraft(entityRef, {
      ID: autoKeys.ID,
      DraftAdministrativeData_DraftUUID: autoKeys.DraftAdministrativeData_DraftUUID
    });

    return autoKeys;
  }

  function toResultPayload(result: any, metadata: AnyRecord = {}) {
    if (Array.isArray(result)) {
      return { rows: result, rowCount: result.length, metadata };
    }
    if (result === undefined || result === null) {
      return { rows: [], rowCount: 0, metadata };
    }
    if (typeof result === 'number') {
      return { rows: [], rowCount: result, metadata };
    }
    return { result, metadata };
  }

  async function handleSqlExecute(input: AnyRecord = {}) {
    const { sql, params, allowWrite = false } = input;
    if (typeof sql !== 'string' || !sql.trim()) {
      throw new Error('The "sql" property must be a non-empty string.');
    }
    const trimmed = sql.trim();
    const firstWordMatch = trimmed.match(/^([A-Za-z]+)/);
    const firstWord = firstWordMatch ? firstWordMatch[1].toUpperCase() : '';
    const readOnlyCommands = new Set(['SELECT', 'WITH', 'SHOW', 'EXPLAIN']);
    const isReadOnly = readOnlyCommands.has(firstWord);
    if (!allowWrite && !isReadOnly) {
      throw new Error('Write operations are disabled. Set allowWrite=true to enable this statement.');
    }
    const statement = cds.raw(trimmed);
    const result = await db.run(statement, params);
    return toResultPayload(result, { command: firstWord || 'RAW' });
  }

  async function handleCqnRead(input: AnyRecord = {}) {
    const { entity, columns, where, limit, offset, draft = 'merged' } = input;
    const entityRef = resolveEntity(entity);
    const { SELECT } = cds.ql;

    const target = draft === 'draft' ? ensureDraftEntity(entityRef, entity) : entityRef;
    const query = SELECT.from(target);

    if (Array.isArray(columns) && columns.length > 0) {
      query.columns(...columns);
    }

    if (where && typeof where === 'object' && Object.keys(where).length) {
      query.where(where);
    }

    if (draft === 'active') {
      query.where({ IsActiveEntity: true });
    } else if (draft === 'draft' && target === entityRef) {
      query.where({ IsActiveEntity: false });
    }

    if (Number.isInteger(offset) && offset >= 0 && Number.isInteger(limit) && limit > 0) {
      query.limit(limit, offset);
    } else if (Number.isInteger(limit) && limit > 0) {
      query.limit(limit);
    } else if (!query.SELECT.limit) {
      query.limit(MAX_ROWS);
    }

    const result = await withServiceContext(async () => service.run(query));
    return toResultPayload(result, { entity: entityRef.name, draft });
  }

  async function handleDraftNew(input: AnyRecord = {}) {
    const { entity } = input;
    const entityRef = resolveEntity(entity);
    const draftEntity = ensureDraftEntity(entityRef, entity);
    // Apply domain defaults only for elements that actually exist
    const basePayload: AnyRecord = {};
    if (draftEntity?.elements) {
      for (const [k, v] of Object.entries(DEFAULT_DRAFT_DATA)) {
        if (k in draftEntity.elements) basePayload[k] = v;
      }
    }
    const rawData: AnyRecord = input.data && typeof input.data === 'object' ? { ...input.data } : {};
    const extraFields: AnyRecord = { ...input };
    delete extraFields.entity;
    delete extraFields.data;
    const payload = { ...basePayload, ...extraFields, ...rawData };
    const result = await withServiceContext(async () => (service as any).new(draftEntity, payload), { event: 'NEW' });

    const instance = Array.isArray(result) ? result[0] : result;
    rememberDraft(entityRef, instance);

    return toResultPayload(result, { entity: entityRef.name, action: 'NEW' });
  }

  async function handleDraftEdit(input: AnyRecord = {}) {
    const { entity } = input;
    const entityRef = resolveEntity(entity);
    const draftEntity = ensureDraftEntity(entityRef, entity);

    let keys = input.keys;
    if (!keys || !Object.keys(keys).length) {
      const id = input.ID;
      if (!id) {
        throw new Error('Bitte die ID der aktiven Instanz angeben, um einen Draft zu erzeugen.');
      }
      keys = { ID: id };
    }

    const result = await withServiceContext(async () => (service as any).edit(entityRef, keys), { event: 'EDIT' });
    const instance = Array.isArray(result) ? result[0] : result;
    rememberDraft(entityRef, instance);

    // Ensure DraftUUID is cached even if not present on the edit result payload
    try {
      const id = instance?.ID ?? (Array.isArray(result) ? result?.[0]?.ID : undefined);
      const hasUUID = Boolean(
        instance?.DraftAdministrativeData_DraftUUID || instance?.draftAdministrativeData_DraftUUID
      );
      if (id !== undefined && id !== null && !hasUUID) {
        const query = cds.ql.SELECT.one
          .from(draftEntity)
          .columns({ ref: ['ID'] }, { ref: ['DraftAdministrativeData_DraftUUID'] })
          .where({ ID: id, IsActiveEntity: false });
        const meta = await withServiceContext(async () => service.run(query));
        if (meta?.DraftAdministrativeData_DraftUUID) {
          console.log('[cap.draft.edit] fetched DraftUUID for cache', {
            ID: id,
            DraftAdministrativeData_DraftUUID: meta.DraftAdministrativeData_DraftUUID
          });
          rememberDraft(entityRef, {
            ID: id,
            DraftAdministrativeData_DraftUUID: meta.DraftAdministrativeData_DraftUUID
          });
        }
      }
    } catch (e) {
      console.log('[cap.draft.edit] failed to fetch DraftUUID for cache', formatError(e));
    }
    return toResultPayload(result, { entity: entityRef.name, action: 'EDIT' });
  }

  async function handleDraftPatch(input: AnyRecord = {}) {
    const { entity } = input;
    const entityRef = resolveEntity(entity);
    const draftEntity = ensureDraftEntity(entityRef, entity);

    const { keys, data } = extractKeysAndData(entityRef, draftEntity, input);

    let mutationKeys = sanitizeDraftKeys(draftEntity, keys, { allowVirtual: ['IsActiveEntity', 'DraftAdministrativeData_DraftUUID'] });

    const normalizedData = normalizePatchData(data);

    // Fallback: auto-resolve DraftUUID if missing
    if (mutationKeys.DraftAdministrativeData_DraftUUID === undefined) {
      try {
        const autoKeys = await autoResolveDraftKeys(entityRef, draftEntity);
        if (autoKeys?.DraftAdministrativeData_DraftUUID) {
          // Prefer provided ID if present, but fill missing fields from autoKeys
          mutationKeys = {
            ...autoKeys,
            ...mutationKeys,
            IsActiveEntity: false
          };
          console.log('[cap.draft.patch] autoResolved mutation keys', mutationKeys);
        }
      } catch (e) {
        // keep going; UPDATE may still succeed if single draft by ID exists
        console.log('[cap.draft.patch] autoResolveDraftKeys failed', formatError(e));
      }
    }

    console.log('[cap.draft.patch] mutationKeys', mutationKeys);
    console.log('[cap.draft.patch] normalizedData', normalizedData);

    if (!normalizedData || !Object.keys(normalizedData).length) {
      throw new Error('Es wurden keine Felder zum Aktualisieren übergeben.');
    }

    const payload = { ...normalizedData };
    if (mutationKeys.DraftAdministrativeData_DraftUUID !== undefined && payload.DraftAdministrativeData_DraftUUID === undefined) {
      payload.DraftAdministrativeData_DraftUUID = mutationKeys.DraftAdministrativeData_DraftUUID;
    }
    if (mutationKeys.IsActiveEntity !== undefined && payload.IsActiveEntity === undefined) {
      payload.IsActiveEntity = mutationKeys.IsActiveEntity;
    }
    if (mutationKeys.ID !== undefined && payload.ID === undefined) {
      payload.ID = mutationKeys.ID;
    }

    let affected;
    try {
      affected = await withServiceContext(
        async () => (service as any).update(draftEntity).set(payload).where(mutationKeys),
        { event: 'UPDATE' }
      );
    } catch (error) {
      console.log('[cap.draft.patch] update failed', {
        error: formatError(error),
        payload,
        mutationKeys
      });
      throw error;
    }

    if (!affected) {
      throw new Error('Kein Draft wurde aktualisiert. Bitte prüfe die ID oder erstelle einen neuen Draft.');
    }

    const { ID } = keys;
    if (ID) {
      const store = getDraftStore(entityRef.name);
      const cached = store.get(ID);
      if (cached) {
        cached.data = { ...cached.data, ...normalizedData };
        cached.timestamp = Date.now();
      }
    }

    // Some CAP service implementations return a number (affected rows),
    // others return the updated instance or an array. Normalize to a count.
    const changed = typeof affected === 'number'
      ? affected
      : Array.isArray(affected)
        ? affected.length
        : 1; // truthy non-number => assume one row affected

    return toResultPayload(changed, { entity: entityRef.name, action: 'PATCH' });
  }

  async function handleDraftSave(input: AnyRecord = {}) {
    const { entity } = input;
    const entityRef = resolveEntity(entity);
    const draftEntity = ensureDraftEntity(entityRef, entity);

    const { keys } = extractKeysAndData(entityRef, draftEntity, input);
    let mutationKeys = sanitizeDraftKeys(draftEntity, keys, { allowVirtual: ['IsActiveEntity', 'DraftAdministrativeData_DraftUUID'] });

    // Fallback: ensure DraftUUID present for save
    if (mutationKeys.DraftAdministrativeData_DraftUUID === undefined) {
      try {
        const autoKeys = await autoResolveDraftKeys(entityRef, draftEntity);
        if (autoKeys?.DraftAdministrativeData_DraftUUID) {
          mutationKeys = {
            ...autoKeys,
            ...mutationKeys,
            IsActiveEntity: false
          };
          console.log('[cap.draft.save] autoResolved mutation keys', mutationKeys);
        }
      } catch (e) {
        console.log('[cap.draft.save] autoResolveDraftKeys failed', formatError(e));
      }
    }

    const result = await withServiceContext(async () => (service as any).save(draftEntity, mutationKeys), { event: 'SAVE' });
    forgetDraft(entityRef, mutationKeys);
    return toResultPayload(result, { entity: entityRef.name, action: 'SAVE' });
  }

  async function handleDraftCancel(input: AnyRecord = {}) {
    const { entity } = input;
    const entityRef = resolveEntity(entity);
    const draftEntity = ensureDraftEntity(entityRef, entity);

    const { keys } = extractKeysAndData(entityRef, draftEntity, input);
    const mutationKeys = sanitizeDraftKeys(draftEntity, keys, { dropKeys: ['IsActiveEntity'] });

    const result = await withServiceContext(async () => (service as any).discard(draftEntity, mutationKeys), { event: 'CANCEL' });
    forgetDraft(entityRef, mutationKeys);
    return toResultPayload(result, { entity: entityRef.name, action: 'CANCEL' });
  }

  async function handleDraftGetAdminData(input: AnyRecord = {}) {
    const { entity, columns } = input;
    const entityRef = resolveEntity(entity);
    const draftEntity = ensureDraftEntity(entityRef, entity);

    let keys;
    try {
      ({ keys } = extractKeysAndData(entityRef, draftEntity, input));
    } catch (error) {
      if (!hasProvidedDraftKeys(input) && isMissingDraftError(error)) {
        const autoKeys = await autoResolveDraftKeys(entityRef, draftEntity);
        if (!autoKeys) {
          throw error;
        }
        keys = autoKeys;
      } else {
        throw error;
      }
    }

    const queryKeys = sanitizeDraftKeys(draftEntity, keys, { dropKeys: ['IsActiveEntity', 'HasActiveEntity', 'HasDraftEntity'] });

    const draftAdminAssoc = draftEntity?.elements?.DraftAdministrativeData;
    const adminTargetElements = draftAdminAssoc?._target?.elements || null;
    let availableColumns = adminTargetElements
      ? Object.keys(adminTargetElements)
      : [...DEFAULT_DRAFT_ADMIN_COLUMNS];

    if (!availableColumns.length) {
      availableColumns = [...DEFAULT_DRAFT_ADMIN_COLUMNS];
    }

    let requestedColumns = Array.isArray(columns) && columns.length ? [...columns] : null;
    if (requestedColumns && adminTargetElements) {
      const normalized = requestedColumns.filter((col) => adminTargetElements[col]);
      if (normalized.length) {
        requestedColumns = normalized;
      } else {
        requestedColumns = null;
      }
    }

    const expandColumns = requestedColumns || availableColumns;
    const expand = !expandColumns.length || expandColumns.includes('*')
      ? [{ ref: ['*'] }]
      : expandColumns.map((col) => ({ ref: [col] }));

    const selectColumns: AnyRecord[] = [
      { ref: ['DraftAdministrativeData'], expand }
    ];

    if (draftEntity.elements?.DraftAdministrativeData_DraftUUID) {
      selectColumns.push({ ref: ['DraftAdministrativeData_DraftUUID'] });
    }

    const query = cds.ql.SELECT.one.from(draftEntity)
      .columns(...selectColumns)
      .where(queryKeys);

    const result = await withServiceContext(async () => service.run(query));
    if (!result) {
      return toResultPayload(null, { entity: entityRef.name, action: 'DRAFT_ADMIN' });
    }

    const adminData = result.DraftAdministrativeData ? { ...result.DraftAdministrativeData } : {};
    if (result.DraftAdministrativeData_DraftUUID !== undefined) {
      adminData.DraftAdministrativeData_DraftUUID = result.DraftAdministrativeData_DraftUUID;
    }

    if (requestedColumns && requestedColumns.length) {
      const filtered = requestedColumns.reduce((acc, col) => {
        if (adminData[col] !== undefined) {
          acc[col] = adminData[col];
        }
        return acc;
      }, {});
      return toResultPayload(filtered, { entity: entityRef.name, action: 'DRAFT_ADMIN' });
    }

    return toResultPayload(adminData, { entity: entityRef.name, action: 'DRAFT_ADMIN' });
  }

  async function handleDraftAddChild(input: AnyRecord = {}) {
    const { entity, child } = input;
    if (!entity || typeof entity !== 'string') {
      throw new Error('Bitte das Draft-Root "entity" angeben.');
    }
    if (!child || typeof child !== 'string') {
      throw new Error('Bitte den Namen des Composition-Elements in "child" angeben.');
    }

    const entriesInput = Array.isArray(input.entries)
      ? input.entries
      : input.entry !== undefined
        ? [input.entry]
        : null;

    if (!entriesInput || !entriesInput.length) {
      throw new Error('Bitte mindestens einen Kind-Eintrag in "entries" oder "entry" übergeben.');
    }

    const entityRef = resolveEntity(entity);
    const draftEntity = ensureDraftEntity(entityRef, entity);

    const childElement = draftEntity.elements?.[child] || entityRef.elements?.[child];
    if (!childElement) {
      throw new Error(`Das Element "${child}" existiert auf "${entityRef.name}" nicht.`);
    }
    if (childElement.type !== 'cds.Composition') {
      throw new Error(`Element "${child}" ist keine Composition und kann nicht mit cap.draft.addChild befüllt werden.`);
    }

    const childTarget = childElement._target;
    if (!childTarget) {
      throw new Error(`Composition "${child}" besitzt kein aufgelöstes Ziel.`);
    }

    const providedKeys: DraftKey = input.keys ? { ...input.keys } : {};
    const convenienceKeys: DraftKey = {};
    if (input.ID) convenienceKeys.ID = input.ID;
    if (input.DraftAdministrativeData_DraftUUID) {
      convenienceKeys.DraftAdministrativeData_DraftUUID = input.DraftAdministrativeData_DraftUUID;
    }

    let resolvedKeys;
    try {
      resolvedKeys = resolveDraftKeys(entityRef, draftEntity, providedKeys, convenienceKeys);
    } catch (error) {
      if (!hasProvidedDraftKeys(input) && isMissingDraftError(error)) {
        const autoKeys = await autoResolveDraftKeys(entityRef, draftEntity);
        if (!autoKeys) {
          throw error;
        }
        resolvedKeys = autoKeys;
      } else {
        throw error;
      }
    }

    const mutationKeys = sanitizeDraftKeys(draftEntity, resolvedKeys, {
      allowVirtual: ['IsActiveEntity', 'DraftAdministrativeData_DraftUUID']
    });

    const childColumns = Object.keys(childTarget.elements || {}).map((col) => ({ ref: [col] }));
    const expand = childColumns.length ? childColumns : [{ ref: ['*'] }];
    const selectColumns = [{ ref: [child], expand }];

    const existing = await withServiceContext(
      async () => service.run(
        cds.ql.SELECT.one.from(draftEntity)
          .columns(...selectColumns)
          .where(mutationKeys)
      )
    );

    const currentEntriesRaw = Array.isArray(existing?.[child]) ? existing[child] : [];
    const currentEntries = JSON.parse(JSON.stringify(currentEntriesRaw));

    const preparedEntries = entriesInput.map((entry, index) => {
      if (!entry || typeof entry !== 'object') {
        throw new Error(`Der Eintrag an Position ${index} ist kein Objekt.`);
      }
      const normalized = { ...entry };

      if (normalized.ID === undefined && childTarget.elements?.ID?.type === 'cds.UUID') {
        const utils = cds.utils as any;
        normalized.ID = utils?.uuid ? utils.uuid() : utils.guid();
      }
      if (childTarget.elements?.IsActiveEntity && normalized.IsActiveEntity === undefined) {
        normalized.IsActiveEntity = false;
      }
      if (childTarget.elements?.HasActiveEntity && normalized.HasActiveEntity === undefined) {
        normalized.HasActiveEntity = false;
      }
      if (childTarget.elements?.HasDraftEntity && normalized.HasDraftEntity === undefined) {
        normalized.HasDraftEntity = false;
      }
      if (
        mutationKeys.DraftAdministrativeData_DraftUUID !== undefined &&
        childTarget.elements?.DraftAdministrativeData_DraftUUID &&
        normalized.DraftAdministrativeData_DraftUUID === undefined
      ) {
        normalized.DraftAdministrativeData_DraftUUID = mutationKeys.DraftAdministrativeData_DraftUUID;
      }

      return normalized;
    });

    const payload = {
      [child]: currentEntries.concat(preparedEntries)
    };

    if (mutationKeys.ID !== undefined) {
      payload.ID = mutationKeys.ID;
    }
    if (mutationKeys.IsActiveEntity !== undefined) {
      payload.IsActiveEntity = mutationKeys.IsActiveEntity;
    }
    if (mutationKeys.DraftAdministrativeData_DraftUUID !== undefined) {
      payload.DraftAdministrativeData_DraftUUID = mutationKeys.DraftAdministrativeData_DraftUUID;
    }

    const result = await withServiceContext(
      async () => (service as any).update(draftEntity).set(payload).where(mutationKeys),
      { event: 'UPDATE' }
    );

    if (mutationKeys.ID !== undefined) {
      const store = getDraftStore(entityRef.name);
      const cached = store.get(mutationKeys.ID);
      if (cached) {
        cached.data = {
          ...cached.data,
          [child]: payload[child]
        };
        cached.timestamp = Date.now();
      }
    }

    return toResultPayload(result, { entity: entityRef.name, action: 'ADD_CHILD', child });
  }

  const handlers: Record<string, (input: AnyRecord) => Promise<any> | any> = {
    'cap.sql.execute': handleSqlExecute,
    'cap.cqn.read': handleCqnRead,
    'cap.draft.new': handleDraftNew,
    'cap.draft.edit': handleDraftEdit,
    'cap.draft.patch': handleDraftPatch,
    'cap.draft.save': handleDraftSave,
    'cap.draft.cancel': handleDraftCancel,
    'cap.draft.getAdminData': handleDraftGetAdminData,
    'cap.draft.addChild': handleDraftAddChild
  };

  const invokeHandler = async (toolName: string, input: AnyRecord): Promise<CallToolResult> => {
    const handler = handlers[toolName];
    if (!handler) {
      throw new Error(`Unknown CAP MCP tool "${toolName}".`);
    }
    const result = await handler(input);
    return toCallToolResult(result);
  };

  const recordAny = z.record(z.any());
  const optionalRecordAny = recordAny.optional();
  const optionalArrayOfRecords = z.array(recordAny).optional();

  const sdkServer = createSdkMcpServer({
    name: 'cap',
    version: '1.0.0',
    tools: [
      tool(
        'cap.sql.execute',
        'Execute a SQL statement through the CAP database connection. Defaults to read-only unless allowWrite is true.',
        {
          sql: z.string(),
          params: z.union([z.array(z.any()), recordAny]).optional(),
          allowWrite: z.boolean().optional()
        },
        async (args) => invokeHandler('cap.sql.execute', args)
      ),
      tool(
        'cap.cqn.read',
        'Run a CAP SELECT query using CQN primitives and return the resulting rows.',
        {
          entity: z.string(),
          columns: z.array(z.string()).optional(),
          where: optionalRecordAny,
          limit: z.number().int().min(1).optional(),
          offset: z.number().int().min(0).optional(),
          draft: z.enum(['merged', 'active', 'draft']).optional()
        },
        async (args) => invokeHandler('cap.cqn.read', args)
      ),
      tool(
        'cap.draft.new',
        'Create a new draft instance for a draft-enabled entity.',
        {
          entity: z.string(),
          data: optionalRecordAny
        },
        async (args) => invokeHandler('cap.draft.new', args)
      ),
      tool(
        'cap.draft.edit',
        'Put an active instance into draft edit mode.',
        {
          entity: z.string(),
          keys: optionalRecordAny,
          ID: z.string().optional()
        },
        async (args) => invokeHandler('cap.draft.edit', args)
      ),
      tool(
        'cap.draft.patch',
        'Apply partial updates to an existing draft instance.',
        {
          entity: z.string(),
          keys: optionalRecordAny,
          // Accept data as object or JSON string so our handler can normalize
          data: z.union([recordAny, z.string()]).optional(),
          // Convenience fields
          ID: z.string().optional(),
          DraftAdministrativeData_DraftUUID: z.string().optional(),
          // Allow common top-level patch fields (preserved through validation)
          status: z.string().optional()
        },
        async (args) => invokeHandler('cap.draft.patch', args)
      ),
      tool(
        'cap.draft.save',
        'Activate a draft and persist it as the active instance.',
        {
          entity: z.string(),
          keys: optionalRecordAny,
          ID: z.string().optional(),
          DraftAdministrativeData_DraftUUID: z.string().optional()
        },
        async (args) => invokeHandler('cap.draft.save', args)
      ),
      tool(
        'cap.draft.cancel',
        'Discard an existing draft instance.',
        {
          entity: z.string(),
          keys: optionalRecordAny,
          ID: z.string().optional(),
          DraftAdministrativeData_DraftUUID: z.string().optional()
        },
        async (args) => invokeHandler('cap.draft.cancel', args)
      ),
      tool(
        'cap.draft.getAdminData',
        'Read DraftAdministrativeData metadata for a draft-enabled entity.',
        {
          entity: z.string(),
          keys: optionalRecordAny,
          columns: z.array(z.string()).optional()
        },
        async (args) => invokeHandler('cap.draft.getAdminData', args)
      ),
      tool(
        'cap.draft.addChild',
        'Append entries to a draft composition element.',
        {
          entity: z.string(),
          child: z.string(),
          entries: optionalArrayOfRecords,
          entry: recordAny.optional(),
          keys: optionalRecordAny,
          ID: z.string().optional(),
          DraftAdministrativeData_DraftUUID: z.string().optional()
        },
        async (args) => invokeHandler('cap.draft.addChild', args)
      )
    ]
  });

  async function listTools() {
    return { tools: toolDefinitions };
  }

  const toCallToolResult = (result: unknown): CallToolResult => {
    const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
    return {
      content: [{ type: 'text', text }],
      isError: false
    };
  };

  async function callTool(
    { name, arguments: args = {} }: { name?: string; arguments?: AnyRecord } = {},
    options: AnyRecord = {}
  ) {
    if (!name) {
      throw new Error('Tool name is required');
    }
    const handler = handlers[name];
    if (!handler) {
      const supported = Object.keys(handlers).join(', ') || '<none>';
      throw new Error(`Unknown CAP MCP tool "${name}". Supported tools: ${supported}`);
    }
    const input = args && typeof args === 'object' ? args : {};

    const invoke = async () => handler(input);

    if (requestContextStorage.getStore()) {
      const result = await invoke();
      return toCallToolResult(result);
    }

    const context = options.context || {};
    const result = await requestContextStorage.run(context, invoke);
    return toCallToolResult(result);
  }

  async function readResource() {
    throw new Error('CAP MCP client does not expose file resources');
  }

  async function close() {
    log.debug?.('Closing CAP MCP in-process client');
  }

  function runWithContext(context: AnyRecord, fn: (...args: unknown[]) => unknown) {
    if (typeof fn !== 'function') {
      throw new Error('runWithContext expects a callback function');
    }
    return requestContextStorage.run(context || {}, fn);
  }

  return {
    listTools,
    callTool,
    readResource,
    close,
    toolDefinitions,
    runWithContext,
    sdkServer
  };
}
