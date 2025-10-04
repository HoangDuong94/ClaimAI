import cds from '@sap/cds';
import { AsyncLocalStorage } from 'node:async_hooks';

const MAX_ROWS = 200;

const DEFAULT_DRAFT_DATA = {
  ort: 'Luzern',
  datum: null
};

// Lightweight in-memory cache that remembers the most recent drafts per entity.
const draftContext = new Map();
const requestContextStorage = new AsyncLocalStorage();

const DEFAULT_DRAFT_ADMIN_COLUMNS = [
  'DraftUUID',
  'CreatedByUser',
  'LastChangedByUser',
  'InProcessByUser',
  'CreatedAt',
  'LastChangedAt'
];

const toolDefinitions = [
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

export async function initCapMCPClient(options = {}) {
  const { service, logger = console } = options;
  if (!service) {
    throw new Error('CAP MCP client requires a service instance. Pass { service } when initializing.');
  }

  const log = typeof logger?.debug === 'function' ? logger : console;
  log.debug?.('Initializing CAP MCP in-process client...');

  const db = await cds.connect.to('db');
  const privilegedUser = cds.User?.Privileged
    ? new cds.User.Privileged('mcp-cap')
    : { id: 'mcp-cap', roles: ['mcp.cap'], attr: {} };

  function resolveEntity(entityName) {
    if (!entityName || typeof entityName !== 'string') {
      throw new Error('Entity name must be a non-empty string');
    }
    const entities = service.entities || {};
    const direct = entities[entityName];
    if (direct) return direct;
    const shortName = entityName.includes('.') ? entityName.split('.').pop() : null;
    if (shortName && entities[shortName]) return entities[shortName];
    const available = Object.keys(entities).join(', ') || '<none>';
    throw new Error(`Unknown entity "${entityName}". Available entities: ${available}`);
  }

  function getDraftStore(entityName) {
    const key = entityName;
    if (!draftContext.has(key)) {
      draftContext.set(key, new Map());
    }
    return draftContext.get(key);
  }

  function rememberDraft(entityRef, draftInstance) {
    const draftUUID = draftInstance?.DraftAdministrativeData_DraftUUID || draftInstance?.draftAdministrativeData_DraftUUID;
    const id = draftInstance?.ID;
    if (!draftUUID || !id) return;
    const store = getDraftStore(entityRef.name);
    const keys = { ID: id, DraftAdministrativeData_DraftUUID: draftUUID, IsActiveEntity: false };
    store.set(id, { keys, data: draftInstance, timestamp: Date.now() });
    store.lastKey = id;
  }

  function forgetDraft(entityRef, keys) {
    const store = getDraftStore(entityRef.name);
    const id = keys?.ID;
    if (id && store.has(id)) {
      store.delete(id);
    }
    if (store.lastKey === id) {
      store.lastKey = undefined;
    }
    if (store.size === 0) {
      draftContext.delete(entityRef.name);
    }
  }

  function hasProvidedDraftKeys(input = {}) {
    if (!input || typeof input !== 'object') return false;
    if (input.keys && Object.keys(input.keys).length) return true;
    if (input.ID) return true;
    if (input.DraftAdministrativeData_DraftUUID) return true;
    return false;
  }

  function isMissingDraftError(error) {
    return error?.message?.includes("Kein passender Draft gefunden");
  }

  function resolveDraftKeys(entityRef, draftEntity, providedKeys = {}, options = {}) {
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
        const cached = store.get(keys.ID);
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
      const cached = store.get(ID);
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

  function extractKeysAndData(entityRef, draftEntity, input = {}) {
    const { keys: rawKeys, data: rawData, ...rest } = input;
    if (rest.entity !== undefined) delete rest.entity;
    const recognizedKeys = rawKeys ? { ...rawKeys } : {};
    const convenienceKeys = {};

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

    const data = rawData && Object.keys(rawData).length
      ? rawData
      : Object.keys(rest).length ? rest : null;

    const resolvedKeys = resolveDraftKeys(entityRef, draftEntity, keys, convenienceKeys);

    return { keys: resolvedKeys, data };
  }

  function ensureDraftEntity(entity, originalName) {
    if (!entity?.drafts) {
      const name = originalName || entity?.name || '<unknown>';
      throw new Error(`Entity "${name}" is not draft-enabled.`);
    }
    return entity.drafts;
  }

  async function withServiceContext(fn, overrides = {}) {
    const previous = cds.context;
    const ambient = requestContextStorage.getStore() || {};
    const effectiveUser = overrides.user || ambient.user || previous?.user || privilegedUser;
    const effectiveTenant = overrides.tenant || ambient.tenant || previous?.tenant || effectiveUser?.tenant;
    const effectiveLocale = overrides.locale || ambient.locale || previous?.locale;

    const context = new cds.Request({
      event: overrides.event || 'READ',
      user: effectiveUser,
      tenant: effectiveTenant,
      locale: effectiveLocale
    });
    try {
      cds.context = context;
      return await fn(context);
    } finally {
      cds.context = previous;
    }
  }

  function sanitizeDraftKeys(entity, keyValues = {}, options = {}) {
    if (!keyValues || typeof keyValues !== 'object') {
      return {};
    }
    const { allowVirtual = [], dropKeys = [] } = options;
    const elements = entity?.elements;
    if (!elements) {
      return { ...keyValues };
    }
    const cleaned = {};
    for (const [key, value] of Object.entries(keyValues)) {
      if (dropKeys.includes(key)) continue;
      const element = elements[key];
      if (element?.virtual && !allowVirtual.includes(key)) continue;
      if (value === undefined) continue;
      cleaned[key] = value;
    }
    return cleaned;
  }

  async function autoResolveDraftKeys(entityRef, draftEntity) {
    const columns = [];

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
        query.orderBy({ ref: [field], sort });
        break;
      }
    }

    const latest = await withServiceContext(async () => service.run(query));
    if (!latest) {
      return null;
    }

    const autoKeys = {};
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

  function toResultPayload(result, metadata = {}) {
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

  async function handleSqlExecute(input = {}) {
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

  async function handleCqnRead(input = {}) {
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

  async function handleDraftNew(input = {}) {
    const { entity } = input;
    const entityRef = resolveEntity(entity);
    const draftEntity = ensureDraftEntity(entityRef, entity);
    // Apply domain defaults only for elements that actually exist
    const basePayload = {};
    if (draftEntity?.elements) {
      for (const [k, v] of Object.entries(DEFAULT_DRAFT_DATA)) {
        if (k in draftEntity.elements) basePayload[k] = v;
      }
    }
    const rawData = input.data && typeof input.data === 'object' ? { ...input.data } : {};
    const extraFields = { ...input };
    delete extraFields.entity;
    delete extraFields.data;
    const payload = { ...basePayload, ...extraFields, ...rawData };
    const result = await withServiceContext(async () => service.new(draftEntity, payload), { event: 'NEW' });

    const instance = Array.isArray(result) ? result[0] : result;
    rememberDraft(entityRef, instance);

    return toResultPayload(result, { entity: entityRef.name, action: 'NEW' });
  }

  async function handleDraftEdit(input = {}) {
    const { entity } = input;
    const entityRef = resolveEntity(entity);

    let keys = input.keys;
    if (!keys || !Object.keys(keys).length) {
      const id = input.ID;
      if (!id) {
        throw new Error('Bitte die ID der aktiven Instanz angeben, um einen Draft zu erzeugen.');
      }
      keys = { ID: id };
    }

    const result = await withServiceContext(async () => service.edit(entityRef, keys), { event: 'EDIT' });
    const instance = Array.isArray(result) ? result[0] : result;
    rememberDraft(entityRef, instance);
    return toResultPayload(result, { entity: entityRef.name, action: 'EDIT' });
  }

  async function handleDraftPatch(input = {}) {
    const { entity } = input;
    const entityRef = resolveEntity(entity);
    const draftEntity = ensureDraftEntity(entityRef, entity);

    const { keys, data } = extractKeysAndData(entityRef, draftEntity, input);

    const mutationKeys = sanitizeDraftKeys(draftEntity, keys, { allowVirtual: ['IsActiveEntity', 'DraftAdministrativeData_DraftUUID'] });

    if (!data || typeof data !== 'object' || !Object.keys(data).length) {
      throw new Error('Es wurden keine Felder zum Aktualisieren übergeben.');
    }

    const payload = { ...data };
    if (mutationKeys.DraftAdministrativeData_DraftUUID !== undefined && payload.DraftAdministrativeData_DraftUUID === undefined) {
      payload.DraftAdministrativeData_DraftUUID = mutationKeys.DraftAdministrativeData_DraftUUID;
    }
    if (mutationKeys.IsActiveEntity !== undefined && payload.IsActiveEntity === undefined) {
      payload.IsActiveEntity = mutationKeys.IsActiveEntity;
    }
    if (mutationKeys.ID !== undefined && payload.ID === undefined) {
      payload.ID = mutationKeys.ID;
    }

    const affected = await withServiceContext(
      async () => service.update(draftEntity).set(payload).where(mutationKeys),
      { event: 'UPDATE' }
    );

    if (!affected) {
      throw new Error('Kein Draft wurde aktualisiert. Bitte prüfe die ID oder erstelle einen neuen Draft.');
    }

    const { ID } = keys;
    if (ID) {
      const store = getDraftStore(entityRef.name);
      const cached = store.get(ID);
      if (cached) {
        cached.data = { ...cached.data, ...data };
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

  async function handleDraftSave(input = {}) {
    const { entity } = input;
    const entityRef = resolveEntity(entity);
    const draftEntity = ensureDraftEntity(entityRef, entity);

    const { keys } = extractKeysAndData(entityRef, draftEntity, input);
    const mutationKeys = sanitizeDraftKeys(draftEntity, keys, { allowVirtual: ['IsActiveEntity', 'DraftAdministrativeData_DraftUUID'] });

    const result = await withServiceContext(async () => service.save(draftEntity, mutationKeys), { event: 'SAVE' });
    forgetDraft(entityRef, mutationKeys);
    return toResultPayload(result, { entity: entityRef.name, action: 'SAVE' });
  }

  async function handleDraftCancel(input = {}) {
    const { entity } = input;
    const entityRef = resolveEntity(entity);
    const draftEntity = ensureDraftEntity(entityRef, entity);

    const { keys } = extractKeysAndData(entityRef, draftEntity, input);
    const mutationKeys = sanitizeDraftKeys(draftEntity, keys, { dropKeys: ['IsActiveEntity'] });

    const result = await withServiceContext(async () => service.discard(draftEntity, mutationKeys), { event: 'CANCEL' });
    forgetDraft(entityRef, mutationKeys);
    return toResultPayload(result, { entity: entityRef.name, action: 'CANCEL' });
  }

  async function handleDraftGetAdminData(input = {}) {
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

    const selectColumns = [
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

  async function handleDraftAddChild(input = {}) {
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

    const providedKeys = input.keys ? { ...input.keys } : {};
    const convenienceKeys = {};
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
        normalized.ID = cds.utils?.uuid ? cds.utils.uuid() : cds.utils.guid();
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
      async () => service.update(draftEntity).set(payload).where(mutationKeys),
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

  const handlers = {
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

  async function listTools() {
    return { tools: toolDefinitions }; 
  }

  async function callTool({ name, arguments: args = {} } = {}, options = {}) {
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
      const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
      return {
        content: [{ type: 'text', text }],
        isError: false
      };
    }

    const context = options.context || {};
    const result = await requestContextStorage.run(context, invoke);
    const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
    return {
      content: [{ type: 'text', text }],
      isError: false
    };
  }

  async function readResource() {
    throw new Error('CAP MCP client does not expose file resources');
  }

  async function close() {
    log.debug?.('Closing CAP MCP in-process client');
  }

  function runWithContext(context, fn) {
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
    runWithContext
  };
}
