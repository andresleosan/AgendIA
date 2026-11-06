import { isAdminPaymentRecord } from '../../shared/admin-payment-actions.ts';
import { isSupportRecord, isSupportRecipient } from '../../shared/platform-support-records.ts';
import { quotaTurnSchema, quotaReceiptSchema, quotaReviewSchema, quotaProtocolSchema, quotaReceiptId } from '../../shared/response-quota-records.ts';
import type { DataCommand, DataRead, DataReadResult, DataCommitResult, DataRecord } from '../../shared/data-protocol.ts';
import { isDataJson, isDataPath } from '../../shared/data-protocol.ts';
import { SINGLETON_NAME } from './router.ts';
import { prepareRecoveryWitness, completeRecoveryWitness, recoveryAdmissionAllowed } from './recovery-witness.ts';
import { recoveryRestricted } from '../../shared/recovery-admission.ts';
import { bookingAdmissionProtocolSchema } from '../../src/lib/booking-admission-release.ts';

const MAX_BODY = 8 * 1024 * 1024;
const MAX_DOCUMENT = 1024 * 1024;
const MAX_READ = 1000;
const REPLAY_MS = 24 * 60 * 60 * 1000;
const encoder = new TextEncoder();
const fields: Record<string, 'string' | 'number' | 'boolean'> = {
  jobId: 'string', outboxId: 'string', conversationId: 'string', recordType: 'string', kind: 'string', sequence: 'number',
  memberUid: 'string', ownerUid: 'string', 'client.uid': 'string', dateKey: 'string', resourceId: 'string', status: 'string', type: 'string', tenantId: 'string', businessId: 'string', phoneNumberId: 'string', state: 'string', bodyState: 'string', id: 'string', appointmentId: 'string',
  createdAt: 'number', updatedAt: 'number', submittedAt: 'number', startsAt: 'number', startAt: 'number', endAt: 'number', nextAttemptAt: 'number', bodyExpiresAt: 'number', expiresAt: 'number', enabled: 'boolean',
  'request.dateKey': 'string', 'request.createdAt': 'number', 'request.id': 'string', waitlistRecordId: 'string',
  __name__: 'string',
};
type DataEnvironment = Pick<CloudflareBindings, 'SARIN_DB' | 'SARIN_FILES'> & RecoveryBindings;
type BlobReference = { key: string; contentType: string; byteLength: number; sha256: string };
type StoredDocument = { path: string; data: string; blob: string | null };

export class DataError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string) {
    super('No se pudo completar la operación de datos.');
    this.status = status;
    this.code = code;
  }
}
const invalid = () => new DataError(400, 'DATA_INVALID');
const limit = () => new DataError(413, 'DATA_LIMIT');
const unavailable = () => new DataError(503, 'DATA_UNAVAILABLE');
function object(value: unknown): value is DataRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
function keys(value: DataRecord, allowed: string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw invalid();
}
function path(value: unknown, document: boolean): asserts value is string {
  if (!isDataPath(value, document)) throw invalid();
}
function validateCommand(command: unknown): asserts command is DataCommand {
  if (!object(command)) throw invalid();
  if (command.action === 'read') {
    keys(command, ['action', 'read']);
    if (!object(command.read)) throw invalid();
    const read = command.read;
    if (read.kind === 'document') { keys(read, ['kind', 'path']); path(read.path, true); return; }
    if (read.kind !== 'query') throw invalid();
    keys(read, ['kind', 'path', 'filters', 'order', 'limit']);
    path(read.path, false);
    if (!Array.isArray(read.filters) || read.filters.length > 8 || !Array.isArray(read.order) || read.order.length > 3) throw invalid();
    if (read.limit !== undefined && (!Number.isInteger(read.limit) || Number(read.limit) < 1 || Number(read.limit) > MAX_READ)) throw invalid();
    for (const filter of read.filters) {
      if (!object(filter)) throw invalid();
      keys(filter, ['field', 'op', 'value']);
      if (typeof filter.field !== 'string' || !Object.hasOwn(fields, filter.field) || typeof filter.op !== 'string' || !['==', '<', '<=', '>', '>='].includes(filter.op) || !isDataJson(filter.value)) throw invalid();
      if (filter.field === '__name__' && (typeof filter.value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(filter.value) || /[\x00-\x1f\x7f]/.test(filter.value))) throw invalid();
      if (filter.value === null) { if (filter.op !== '==') throw invalid(); }
      else if (typeof filter.value !== fields[filter.field]) throw invalid();
      if (typeof filter.value === 'boolean' && filter.op !== '==') throw invalid();
    }
    for (const order of read.order) {
      if (!object(order)) throw invalid();
      keys(order, ['field', 'direction']);
      if (typeof order.field !== 'string' || !Object.hasOwn(fields, order.field) || typeof order.direction !== 'string' || !['asc', 'desc'].includes(order.direction)) throw invalid();
    }
    if (read.path === 'adminPaymentActions' && (!read.order.some(item => object(item) && ['expiresAt', 'bodyExpiresAt'].includes(String(item.field))) || read.filters.some(item => object(item) && !['expiresAt', 'bodyExpiresAt', 'state'].includes(String(item.field))))) throw invalid();
    return;
  }
  if (command.action !== 'commit') throw invalid();
  keys(command, ['action', 'expectedRevision', 'requestId', 'writes']);
  if (!Number.isSafeInteger(command.expectedRevision) || Number(command.expectedRevision) < 0 || Number(command.expectedRevision) >= Number.MAX_SAFE_INTEGER || typeof command.requestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(command.requestId)) throw invalid();
  if (!Array.isArray(command.writes) || command.writes.length > 100) throw limit();
  for (const write of command.writes) {
    if (!object(write)) throw invalid();
    path(write.path, true);
    if (write.op === 'delete') { keys(write, ['op', 'path']); if (['adminPaymentActions/key_marker', 'platformSupportConversations/key_marker', 'serverSettings/responseQuotaProtocol', 'serverSettings/bookingAdmissionProtocol'].includes(write.path) || write.path.startsWith('responseQuotaReceipts/') || /^responseQuotaTurns\/[^/]+\/reviews\//.test(write.path)) throw invalid(); continue; }
    if (typeof write.op !== 'string' || !['set', 'create'].includes(write.op)) throw invalid();
    keys(write, write.op === 'set' ? ['op', 'path', 'data', 'merge'] : ['op', 'path', 'data']);
    if (!object(write.data) || !isDataJson(write.data) || (write.merge !== undefined && typeof write.merge !== 'boolean')) throw invalid();
    if (encoder.encode(JSON.stringify(write.data)).length > MAX_DOCUMENT) throw limit();
    if (write.path.startsWith('responseQuotaReceipts/') && (write.op !== 'create' || !quotaReceiptSchema.safeParse(write.data).success)) throw invalid();
    if (/^responseQuotaTurns\/[^/]+\/reviews\//.test(write.path) && (write.op !== 'create' || !quotaReviewSchema.safeParse(write.data).success)) throw invalid();
    if (/^responseQuotaTurns\/[^/]+$/.test(write.path) && write.data.execution !== undefined && (write.merge || !quotaTurnSchema.safeParse(write.data).success || write.data.reservationId !== write.path.split('/')[1])) throw invalid();
    if (write.path === 'serverSettings/responseQuotaProtocol' && (write.merge || !quotaProtocolSchema.safeParse(write.data).success)) throw invalid();
    if (write.path === 'serverSettings/bookingAdmissionProtocol' && (write.merge || !bookingAdmissionProtocolSchema.safeParse(write.data).success)) throw invalid();
    if (/^payment(?:Images|Receipts)\//.test(write.path) && Object.hasOwn(write.data, 'receiptDataUrl')) receipt(write.data.receiptDataUrl);
    if (write.path.startsWith('businessLogos/')) {
      if (typeof write.data.businessId !== 'string' || !/^[A-Za-z0-9_-]{1,60}$/.test(write.data.businessId) || typeof write.data.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(write.data.sha256) || write.path !== `businessLogos/${write.data.businessId}_${write.data.sha256}` || typeof write.data.ownerUid !== 'string' || !write.data.ownerUid || write.data.ownerUid.length > 256 || !Number.isSafeInteger(write.data.createdAt) || Number(write.data.createdAt) < 0) throw invalid();
      logo(write.data.logoDataUrl);
    }
    if (write.path.startsWith('adminPaymentActions/') && (write.merge || !isAdminPaymentRecord(write.path, write.data))) throw invalid();
    if (/^platformSupport(?:Conversations|Messages)\//.test(write.path) && (write.merge || !isSupportRecord(write.path, write.data))) throw invalid();
    if (write.path === 'platformSettings/platform_support_recipient' && (write.merge || !isSupportRecipient(write.data))) throw invalid();
  }
}
function validate(command: unknown): asserts command is DataCommand {
  // Validate payload depth from the record root, as Node and migration preflight
  // do; transport envelope nesting must not consume the record's depth budget.
  validateCommand(command);
  if (encoder.encode(JSON.stringify(command)).length > MAX_BODY) throw limit();
}
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (object(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
async function digest(value: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', value);
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}
function merge(previous: DataRecord, next: DataRecord): DataRecord {
  const result = { ...previous };
  for (const [key, value] of Object.entries(next)) result[key] = object(value) && object(previous[key]) ? merge(previous[key], value) : value;
  return result;
}
function receipt(value: unknown): { bytes: Uint8Array; contentType: string } {
  if (typeof value !== 'string' || value.length > 210000) throw invalid();
  const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match || match[2].length % 4) throw invalid();
  let raw: string;
  try { raw = atob(match[2]); } catch { throw invalid(); }
  if (raw.length < 12 || raw.length > 150 * 1024 || btoa(raw) !== match[2]) throw invalid();
  const bytes = Uint8Array.from(raw, char => char.charCodeAt(0));
  if (match[1] === 'png' && ![137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte)) throw invalid();
  if (match[1] === 'jpeg' && !(bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255)) throw invalid();
  if (match[1] === 'webp' && !(raw.slice(0, 4) === 'RIFF' && raw.slice(8, 12) === 'WEBP')) throw invalid();
  return { bytes, contentType: `image/${match[1]}` };
}
function logo(value: unknown): { bytes: Uint8Array; contentType: string } {
  if (typeof value !== 'string' || value.length > 349551) throw invalid();
  const match = /^data:image\/webp;base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match || match[1].length % 4) throw invalid();
  let raw: string;
  try { raw = atob(match[1]); } catch { throw invalid(); }
  if (raw.length < 12 || raw.length > 256 * 1024 || btoa(raw) !== match[1] || raw.slice(0, 4) !== 'RIFF' || raw.slice(8, 12) !== 'WEBP') throw invalid();
  return { bytes: Uint8Array.from(raw, char => char.charCodeAt(0)), contentType: 'image/webp' };
}
function imagePolicy(path: string) {
  if (/^payment(?:Images|Receipts)\//.test(path)) return { prefix: 'payment-images', field: 'receiptDataUrl', max: 150 * 1024, contentTypes: ['image/png', 'image/jpeg', 'image/webp'] };
  if (path.startsWith('businessLogos/')) return { prefix: 'business-logos', field: 'logoDataUrl', max: 256 * 1024, contentTypes: ['image/webp'] };
  return null;
}
function sqlRead(read: DataRead, db: D1Database): D1PreparedStatement {
  if (read.kind === 'document') return db.prepare('SELECT path,data,blob FROM app_documents WHERE path=?').bind(read.path);
  const clauses = ['parent=?'];
  const values: (string | number)[] = [read.path];
  const sqlType = (field: string) => fields[field] === 'number' ? "IN ('integer','real')" : fields[field] === 'boolean' ? "IN ('true','false')" : "= 'text'";
  for (const filter of read.filters) {
    if (filter.field === '__name__') { clauses.push(`document_id ${filter.op === '==' ? '=' : filter.op} ?`); values.push(filter.value as string); continue; }
    const location = `$.${filter.field}`;
    if (filter.value === null) { clauses.push(`json_type(data,'${location}') = 'null'`); continue; }
    clauses.push(`json_type(data,'${location}') ${sqlType(filter.field)}`);
    clauses.push(`json_extract(data,'${location}') ${filter.op === '==' ? '=' : filter.op} ?`);
    values.push(typeof filter.value === 'boolean' ? Number(filter.value) : filter.value);
  }
  for (const item of read.order) if (item.field !== '__name__') clauses.push(`json_type(data,'$.${item.field}') ${sqlType(item.field)}`);
  const order = [...read.order.map(item => `${item.field === '__name__' ? 'document_id' : `json_extract(data,'$.${item.field}')`} ${item.direction.toUpperCase()}`), 'path ASC'];
  values.push(read.limit ?? MAX_READ + 1);
  return db.prepare(`SELECT path,data,blob FROM app_documents WHERE ${clauses.join(' AND ')} ORDER BY ${order.join(',')} LIMIT ?`).bind(...values);
}
async function hydrate(row: StoredDocument, env: DataEnvironment, includeImage: boolean): Promise<{ path: string; data: DataRecord }> {
  const data: DataRecord = JSON.parse(row.data);
  if (row.blob && includeImage) {
    const blob: BlobReference = JSON.parse(row.blob);
    const policy = imagePolicy(row.path);
    if (!policy || !/^[a-f0-9]{64}$/.test(blob.sha256) || blob.key !== `${policy.prefix}/${blob.sha256}` || !policy.contentTypes.includes(blob.contentType) || !Number.isInteger(blob.byteLength) || blob.byteLength < 12 || blob.byteLength > policy.max) throw unavailable();
    if (policy.field === 'logoDataUrl' && (data.sha256 !== blob.sha256 || row.path !== `businessLogos/${data.businessId}_${blob.sha256}`)) throw unavailable();
    const stored = await env.SARIN_FILES.get(blob.key);
    if (!stored || stored.size !== blob.byteLength) throw unavailable();
    const bytes = new Uint8Array(await stored.arrayBuffer());
    if (await digest(bytes) !== blob.sha256) throw unavailable();
    let raw = '';
    for (const byte of bytes) raw += String.fromCharCode(byte);
    data[policy.field] = `data:${blob.contentType};base64,${btoa(raw)}`;
  }
  return { path: row.path, data };
}
async function readCommand(command: Extract<DataCommand, { action: 'read' }>, env: DataEnvironment): Promise<DataReadResult> {
  const results = await env.SARIN_DB.batch([
    env.SARIN_DB.prepare('SELECT revision FROM app_revision WHERE id=1'), sqlRead(command.read, env.SARIN_DB),
  ]);
  const revision = (results[0].results[0] as { revision: number } | undefined)?.revision;
  if (!Number.isSafeInteger(revision)) throw unavailable();
  const rows = results[1].results as StoredDocument[];
  if (rows.length > MAX_READ) throw limit();
  const documents = [];
  let bytes = 0;
  for (const row of rows) {
    const document = await hydrate(row, env, command.read.kind === 'document');
    bytes += encoder.encode(JSON.stringify(document)).length;
    if (bytes > MAX_BODY) throw limit();
    documents.push(document);
  }
  return { revision: revision!, documents };
}
async function journal(command: Extract<DataCommand, { action: 'commit' }>, fingerprint: string, env: DataEnvironment): Promise<DataCommitResult | null> {
  const previous = await env.SARIN_DB.prepare('SELECT fingerprint,revision FROM app_commits WHERE request_id=? AND created_at>=?').bind(command.requestId, Date.now() - REPLAY_MS).first<{ fingerprint: string; revision: number }>();
  if (!previous) return null;
  if (previous.fingerprint !== fingerprint) throw invalid();
  return { revision: previous.revision };
}
async function commitCommand(command: Extract<DataCommand, { action: 'commit' }>, env: DataEnvironment): Promise<DataCommitResult> {
  const fingerprint = await digest(encoder.encode(stable(command)));
  const replay = await journal(command, fingerprint, env);
  if (replay) {
    await completeRecoveryWitness(await prepareRecoveryWitness(command, env), replay, env);
    return replay;
  }
  // Read prior values for deep merge; the following CAS aborts if anything changed.
  const paths = [...new Set([...command.writes.map(write => write.path), ...(command.writes.some(write => write.path.startsWith('responseQuota')) ? ['serverSettings/responseQuotaProtocol'] : [])])];
  const previous = await env.SARIN_DB.batch([...paths.map(path => env.SARIN_DB.prepare('SELECT path,data,blob FROM app_documents WHERE path=?').bind(path)), env.SARIN_DB.prepare('SELECT revision FROM app_revision WHERE id=1')]);
  const readRevision = previous.pop()?.results[0] as { revision: number } | undefined;
  if (!readRevision || !Number.isSafeInteger(readRevision.revision) || readRevision.revision < 0) throw new DataError(503, 'DATA_UNAVAILABLE');
  // Validate stateful fences against the same revision as their read snapshot.
  if (readRevision?.revision !== command.expectedRevision) throw new DataError(409, 'DATA_CONFLICT');
  const state = new Map<string, { data: DataRecord; blob: string | null }>();
  for (const result of previous) {
    const row = result.results[0] as StoredDocument | undefined;
    if (row) state.set(row.path, { data: JSON.parse(row.data), blob: row.blob });
  }
  const statements: D1PreparedStatement[] = [
    env.SARIN_DB.prepare('DELETE FROM app_commits WHERE created_at<?').bind(Date.now() - REPLAY_MS),
    env.SARIN_DB.prepare('INSERT INTO app_commits(request_id,fingerprint,revision,created_at) VALUES(?,?,?,?)').bind(command.requestId, fingerprint, command.expectedRevision + 1, Date.now()),
    env.SARIN_DB.prepare('UPDATE app_revision SET revision=? WHERE id=1').bind(command.expectedRevision + 1),
  ];
  for (const write of command.writes) {
    if (write.path.startsWith('responseQuotaReceipts/') && write.op !== 'delete' && write.path !== `responseQuotaReceipts/${await quotaReceiptId(quotaReceiptSchema.parse(write.data))}`) throw invalid();
    if (/^responseQuotaTurns\/[^/]+$/.test(write.path)) {
      if (write.op === 'delete') throw invalid();
      const cutoff = state.get('serverSettings/responseQuotaProtocol');
      if (cutoff && (!quotaProtocolSchema.safeParse(cutoff.data).success || !quotaTurnSchema.safeParse(write.data).success || !write.data.execution || write.merge)) throw invalid();
      const oldTurn = state.get(write.path)?.data;
      if (oldTurn?.execution && write.data.execution && oldTurn.attemptId === write.data.attemptId) {
        const old = quotaTurnSchema.parse(oldTurn), next = quotaTurnSchema.parse(write.data);
        if (old.status !== 'reserved' && stable(old) !== stable(next)) throw invalid();
        if (old.execution!.mayHaveDispatched && !next.execution!.mayHaveDispatched) throw invalid();
        if (next.execution!.fenceRevision < old.execution!.fenceRevision) throw invalid();
      }
    }
    if (write.path === 'serverSettings/responseQuotaProtocol' && write.op !== 'delete' && state.has(write.path) && stable(state.get(write.path)!.data) !== stable(write.data)) throw invalid();
    if (write.path === 'serverSettings/bookingAdmissionProtocol' && write.op !== 'delete' && state.has(write.path) && stable(state.get(write.path)!.data) !== stable(write.data)) throw invalid();
    if (write.op === 'delete') {
      state.delete(write.path);
      statements.push(env.SARIN_DB.prepare('DELETE FROM app_documents WHERE path=?').bind(write.path));
      continue;
    }
    const old = state.get(write.path);
    const data = write.op === 'set' && write.merge ? merge(old?.data ?? {}, write.data) : { ...write.data };
    let blob = write.op === 'set' && write.merge ? old?.blob ?? null : null;
    const policy = imagePolicy(write.path);
    if (policy && Object.hasOwn(data, policy.field)) {
      const image = policy.field === 'logoDataUrl' ? logo(data[policy.field]) : receipt(data[policy.field]);
      const sha256 = await digest(image.bytes);
      if (policy.field === 'logoDataUrl' && data.sha256 !== sha256) throw invalid();
      const reference: BlobReference = { key: `${policy.prefix}/${sha256}`, sha256, contentType: image.contentType, byteLength: image.bytes.length };
      // Upload before D1: failure cannot publish a dangling reference. CAS failure
      // may leave an immutable private orphan; do not delete rollback objects here.
      // Physical GC must also respect recovery source pins; logical deletion stays immediate.
      const uploaded = await env.SARIN_FILES.put(reference.key, image.bytes, { httpMetadata: { contentType: image.contentType }, sha256 });
      if (!uploaded) throw unavailable();
      delete data[policy.field];
      blob = JSON.stringify(reference);
    }
    state.set(write.path, { data, blob });
    if (encoder.encode(JSON.stringify(data)).length > MAX_DOCUMENT) throw limit();
    const pieces = write.path.split('/');
    const sql = 'INSERT INTO app_documents(path,parent,document_id,data,updated_at,blob) VALUES(?,?,?,?,?,?)';
    statements.push(env.SARIN_DB.prepare(write.op === 'create' ? sql : `${sql} ON CONFLICT(path) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at,blob=excluded.blob`)
      .bind(write.path, pieces.slice(0, -1).join('/'), pieces.at(-1)!, JSON.stringify(data), Date.now(), blob));
  }
  const intent = await prepareRecoveryWitness(command, env);
  try { await env.SARIN_DB.batch(statements); }
  catch (error) {
    const completed = await journal(command, fingerprint, env);
    if (completed) { await completeRecoveryWitness(intent, completed, env); return completed; }
    const detail = error instanceof Error ? error.message : '';
    if (detail.includes('SARIN_REVISION_CONFLICT')) throw new DataError(409, 'DATA_CONFLICT');
    if (detail.includes('UNIQUE constraint failed: app_documents.path')) throw new DataError(409, 'DATA_EXISTS');
    throw unavailable();
  }
  const result = { revision: command.expectedRevision + 1 };
  await completeRecoveryWitness(intent, result, env);
  return result;
}

export async function executeDataCommand(command: unknown, env: DataEnvironment): Promise<DataReadResult | DataCommitResult> {
  validate(command); // Entire command validated before even accessing a binding.
  if (command.action === 'commit') for (const write of command.writes) {
    if (write.op !== 'delete' && write.path.startsWith('businessLogos/') && await digest(logo(write.data.logoDataUrl).bytes) !== write.data.sha256) throw invalid();
  }
  if (recoveryRestricted(env) && (command.action === 'commit' || !await recoveryAdmissionAllowed(env))) throw unavailable();
  try { return command.action === 'read' ? await readCommand(command, env) : await commitCommand(command, env); }
  catch (error) { if (error instanceof DataError) throw error; throw unavailable(); }
}

export async function handleDataOutbound(request: Request, env: CloudflareBindings, ctx: { containerId: string; className: string }): Promise<Response> {
  const headers = { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' };
  const fail = (status: number, code: string) => Response.json({ error: 'No se pudo completar la operación de datos.', code }, { status, headers });
  if (ctx.className !== 'SarinApp' || ctx.containerId !== env.SARIN_APP.idFromName(SINGLETON_NAME).toString()) return fail(403, 'DATA_FORBIDDEN');
  if (request.url !== 'http://sarin-data.internal/execute') return fail(404, 'DATA_INVALID');
  if (request.method !== 'POST') return fail(405, 'DATA_INVALID');
  try {
    if (Number(request.headers.get('Content-Length') ?? 0) > MAX_BODY) throw limit();
    const reader = request.body?.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    if (reader) {
      try { while (true) {
        const next = await reader.read();
        if (next.done) break;
        total += next.value.byteLength;
        if (total > MAX_BODY) { await reader.cancel(); throw limit(); }
        chunks.push(next.value);
      } } finally { reader.releaseLock(); }
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    let command: unknown;
    try { command = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)); } catch { throw invalid(); }
    return Response.json(await executeDataCommand(command, env), { headers });
  } catch (error) {
    const failure = error instanceof DataError ? error : unavailable();
    return fail(failure.status, failure.code);
  }
}
