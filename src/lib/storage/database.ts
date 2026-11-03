import 'server-only';
import { randomUUID } from 'node:crypto';
import type { DataCommand, DataCommitResult, DataFilter, DataRead, DataReadResult, DataRecord, DataWrite } from '../../../shared/data-protocol';
import { isDataJson, isDataPath } from '../../../shared/data-protocol';
import type { CollectionReference, Database, DocumentReference, DocumentSnapshot, Query, QueryDocumentSnapshot, QuerySnapshot, Transaction } from './types';
import { HttpError } from '@/lib/server/http';
import { recoveryRestricted } from '../../../shared/recovery-admission';

export class StorageError extends HttpError {
  constructor(status: number, code: string) {
    super(status, status === 413 ? 'La consulta de datos supera el límite permitido.' : status === 409 ? 'Los datos cambiaron. Vuelve a intentar la operación.' : 'Los datos están temporalmente indisponibles. Inténtalo de nuevo.', code);
  }
}
export type DataTransport = (command: DataCommand) => Promise<DataReadResult | DataCommitResult>;
const segment = /^[A-Za-z0-9_-]{1,128}$/;
const field = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const invalid = () => new StorageError(400, 'DATA_INVALID');

function assertSegment(value: string): string {
  if (typeof value !== 'string' || !segment.test(value) || ['__proto__', 'prototype', 'constructor'].includes(value)) throw invalid();
  return value;
}
function jsonCopy(value: unknown, depth = 0): unknown {
  if (depth > 32) throw invalid();
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return Array.from(value, entry => jsonCopy(entry, depth + 1));
  if (value && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    const result: DataRecord = {};
    for (const [key, entry] of Object.entries(value)) {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) throw invalid();
      result[key] = jsonCopy(entry, depth + 1);
    }
    return result;
  }
  throw invalid();
}
function recordCopy(value: object): DataRecord {
  if (Array.isArray(value) || value === null || !isDataJson(value)) throw invalid();
  return jsonCopy(value) as DataRecord;
}

async function privateTransport(command: DataCommand): Promise<DataReadResult | DataCommitResult> {
  const response = await fetch('http://sarin-data.internal/execute', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(command),
    signal: AbortSignal.timeout(20_000), redirect: 'error', cache: 'no-store',
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const code = body && typeof body === 'object' && 'code' in body && typeof body.code === 'string' && /^DATA_[A-Z_]+$/.test(body.code) ? body.code : 'DATA_UNAVAILABLE';
    throw new StorageError([400, 409, 413, 503].includes(response.status) ? response.status : 503, code);
  }
  if (!body || typeof body !== 'object' || !('revision' in body) || !Number.isSafeInteger(body.revision) || Number(body.revision) < 0) throw new StorageError(503, 'DATA_UNAVAILABLE');
  if (command.action === 'read' && (!('documents' in body) || !Array.isArray(body.documents))) throw new StorageError(503, 'DATA_UNAVAILABLE');
  return body as DataReadResult | DataCommitResult;
}

/** A bounded application data API; no Firestore SDK or remote SQL credentials. */
export function createCloudflareDatabase(transport: DataTransport = privateTransport): Database {
  const identity = Symbol('database');
  async function read(spec: DataRead): Promise<DataReadResult> {
    const result = await transport({ action: 'read', read: spec });
    if (!('documents' in result) || !Array.isArray(result.documents) || !Number.isSafeInteger(result.revision) || result.revision < 0) throw new StorageError(503, 'DATA_UNAVAILABLE');
    for (const document of result.documents) {
      if (typeof document.path !== 'string' || (spec.kind === 'document' ? document.path !== spec.path : !document.path.startsWith(spec.path + '/') || document.path.split('/').length !== spec.path.split('/').length + 1)) throw new StorageError(503, 'DATA_UNAVAILABLE');
    }
    return result;
  }
  function snapshot(path: string, data?: DataRecord): DocumentSnapshot {
    return { id: path.split('/').at(-1)!, exists: data !== undefined, data: () => data === undefined ? undefined : recordCopy(data), get: name => name.split('.').reduce<unknown>((value, key) => value && typeof value === 'object' ? (value as DataRecord)[key] : undefined, data) };
  }
  function querySnapshot(result: DataReadResult): QuerySnapshot {
    const docs = result.documents.map(document => snapshot(document.path, document.data) as QueryDocumentSnapshot);
    return { docs, empty: docs.length === 0, size: docs.length };
  }
  class Reference implements DocumentReference {
    readonly owner = identity;
    constructor(readonly path: string) { if (!isDataPath(path, true)) throw invalid(); }
    get id() { return this.path.split('/').at(-1)!; }
    collection(name: string): CollectionReference { return new Collection({ kind: 'query', path: `${this.path}/${assertSegment(name)}`, filters: [], order: [] }); }
    async get(): Promise<DocumentSnapshot> { return snapshot(this.path, (await read({ kind: 'document', path: this.path })).documents[0]?.data); }
    async set(data: object, options?: { merge?: boolean }): Promise<void> { await database.runTransaction(async tx => { tx.set(this, data, options); }); }
    async delete(): Promise<void> { await database.runTransaction(async tx => { tx.delete(this); }); }
  }
  class Collection implements CollectionReference {
    readonly owner = identity;
    constructor(readonly spec: Extract<DataRead, { kind: 'query' }>) { if (!isDataPath(spec.path, false)) throw invalid(); }
    doc(id: string): DocumentReference { return new Reference(`${this.spec.path}/${assertSegment(id)}`); }
    where(name: string, op: DataFilter['op'], value: DataFilter['value']): Query {
      if (!field.test(name) || name.split('.').some(key => ['__proto__', 'constructor', 'prototype'].includes(key)) || !['==', '<', '<=', '>', '>='].includes(op) || (value !== null && !['number', 'string', 'boolean'].includes(typeof value)) || (typeof value === 'number' && !Number.isFinite(value))) throw invalid();
      return new Collection({ ...this.spec, filters: [...this.spec.filters, { field: name, op, value }] });
    }
    orderBy(name: string, direction: 'asc' | 'desc' = 'asc'): Query {
      if (!field.test(name) || !['asc', 'desc'].includes(direction)) throw invalid();
      return new Collection({ ...this.spec, order: [...this.spec.order, { field: name, direction }] });
    }
    limit(count: number): Query {
      if (!Number.isSafeInteger(count) || count < 1 || count > 1000) throw invalid();
      return new Collection({ ...this.spec, limit: count });
    }
    async get(): Promise<QuerySnapshot> { return querySnapshot(await read(this.spec)); }
  }
  function targetSpec(target: DocumentReference | Query): DataRead {
    if (!(target instanceof Reference || target instanceof Collection) || target.owner !== identity) throw invalid();
    return target instanceof Reference ? { kind: 'document', path: target.path } : target.spec;
  }
  async function commit(command: Extract<DataCommand, { action: 'commit' }>): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try { await transport(command); return; }
      catch (error) {
        // Only this identical, journaled commit is safe to repeat after a lost
        // transport response. Never recompute business logic on ambiguity.
        if (attempt === 0 && (!(error instanceof StorageError) || error.status === 503)) continue;
        throw error;
      }
    }
  }
  const database: Database = {
    collection(name) { return new Collection({ kind: 'query', path: assertSegment(name), filters: [], order: [] }); },
    async runTransaction<T>(handler: (transaction: Transaction) => Promise<T>, options?: { maxAttempts?: number }): Promise<T> {
      if (recoveryRestricted({ SARIN_RECOVERY_MODE: process.env.SARIN_RECOVERY_MODE })) throw new StorageError(503, 'DATA_RECOVERY_CLOSED');
      const maxAttempts = options?.maxAttempts ?? 10;
      if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) throw invalid();
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        let revision: number | undefined;
        let closed = false;
        const writes: DataWrite[] = [];
        const assertOpen = () => { if (closed) throw invalid(); };
        const acceptRevision = (value: number) => {
          if (revision !== undefined && revision !== value) throw new StorageError(409, 'DATA_CONFLICT');
          revision = value;
        };
        const stage = (target: DocumentReference, data: object, op: 'set' | 'create', options?: { merge?: boolean }) => {
          assertOpen();
          const spec = targetSpec(target);
          if (spec.kind !== 'document' || writes.length >= 100) throw invalid();
          writes.push({ op, path: spec.path, data: recordCopy(data), ...(options?.merge ? { merge: true } : {}) });
        };
        const transaction = {
          async get(target: DocumentReference | Query) {
            assertOpen();
            const spec = targetSpec(target);
            const result = await read(spec);
            assertOpen();
            acceptRevision(result.revision);
            return spec.kind === 'document' ? snapshot(spec.path, result.documents[0]?.data) : querySnapshot(result);
          },
          set(target: DocumentReference, data: object, options?: { merge?: boolean }) { stage(target, data, 'set', options); },
          create(target: DocumentReference, data: object) { stage(target, data, 'create'); },
          delete(target: DocumentReference) {
            assertOpen();
            const spec = targetSpec(target);
            if (spec.kind !== 'document' || writes.length >= 100) throw invalid();
            writes.push({ op: 'delete', path: spec.path });
          },
        } as Transaction;
        try {
          const result = await handler(transaction);
          if (writes.length) {
            if (revision === undefined) acceptRevision((await read({ kind: 'document', path: writes[0].path })).revision);
            closed = true;
            await commit({ action: 'commit', expectedRevision: revision!, requestId: randomUUID(), writes });
          }
          closed = true;
          return result;
        } catch (error) {
          closed = true;
          if (error instanceof StorageError && error.code === 'DATA_CONFLICT') continue;
          throw error;
        }
      }
      throw new StorageError(409, 'DATA_CONFLICT');
    },
  };
  return database;
}
