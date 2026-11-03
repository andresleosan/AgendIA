import { seedPagination, paginationAppointment, paginationBusiness, paginationActor, paginationNow } from './client-appointments-pagination-storage-contract';
import { readClientAppointmentsPage, readClientAppointment } from '@/lib/server/client-appointments-pagination';
import { seedFactualFaqScenario, factualFaqNow, syntheticFaqItems } from './business-factual-faq-contract';
import { saveOwnerFactualFaq } from '@/lib/server/business-factual-faq';
import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import {
  buildImportSql, buildReversePlan, canonicalJson, captureFirestoreSnapshot, collectFirestoreDocuments, decodeFirestoreValue,
  prepareMigration, privateDirectory, restoreFirestoreWrites, sha256, verifyImportedRows, verifyMigration, normalizeImportedRow, encodeFirestoreValue,
  readPreparedBundle, resolveBackupDirectory, writePreparedBundle, writeSourceBackup,
} from '../scripts/lib/data-migration.mjs';
import { firestoreRequester, googleCloudSdkCommand, parseArguments, queryD1 } from '../scripts/cloudflare-data-migration.mjs';
import { createDataTestRuntime } from '../cloudflare/tests/data-runtime.mjs';
import { verifyD1Backup } from '../scripts/verify-d1-backup.mjs';
import { classifyBackupDocument } from '../scripts/lib/recovery-backup.mjs';
import { attendanceCorrectionCommand, attendanceFixture, attendanceNow } from './appointment-attendance-contract';
import { updateAppointmentAttendance } from '@/lib/server/appointment-attendance';
import { memoryFirestore } from './memoryFirestore';
import { seedOwnerRescheduleScenario, ownerRescheduleActor, ownerRescheduleBusiness, ownerRescheduleSource, ownerRescheduleSelection, ownerRescheduleNow } from './owner-rescheduling-contract';
import { readOwnerRescheduleSource, prepareOwnerReschedule, confirmOwnerReschedule } from '@/lib/server/owner-rescheduling';
import { quotaStorageSetup, quotaStorageNow, quotaStorageInput } from './response-quota-storage-contract';
import { markResponseQuotaDispatch } from '@/lib/server/response-quota-store';
import { reconcileResponseQuota } from '@/lib/server/response-quota-admin';
import { reserveResponseQuota } from '@/lib/server/response-quota';
import { createCloudflareDatabase, StorageError } from '@/lib/storage/database';
import type { DataReadResult, DataCommitResult } from '../shared/data-protocol';

const prefix = 'projects/sarinbotsaas/databases/(default)/documents/';
const stamp = '2026-10-16T12:00:00.123456Z';
const image = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const dataUrl = `data:image/png;base64,${image.toString('base64')}`;
const rawDocument = (path: string, fields: Record<string, unknown>) => ({ name: `${prefix}${path}`, fields, createTime: stamp, updateTime: stamp });
const webp = (length = 20) => { const bytes = Buffer.alloc(length); bytes.write('RIFF'); bytes.write('WEBP', 8); return bytes; };
function logoDocument(bytes: Buffer) {
  const digest = sha256(bytes);
  return rawDocument(`businessLogos/owner_${digest}`, { businessId: { stringValue: 'owner' }, ownerUid: { stringValue: 'owner' }, sha256: { stringValue: digest }, createdAt: { integerValue: '1000' }, logoDataUrl: { stringValue: `data:image/webp;base64,${bytes.toString('base64')}` } });
}
function snapshot() {
  return { version: 1, projectId: 'sarinbotsaas', databaseId: '(default)', readTime: stamp,
    collections: ['businesses', 'businesses/missing/appointments', 'paymentImages'], missingAncestors: ['businesses/missing'],
    documents: [
      rawDocument('businesses/owner_quoted', { ownerUid: { stringValue: "uid'private" }, appointments: { integerValue: '10' }, amount: { doubleValue: 1.25 }, exactDouble: { doubleValue: 1 }, active: { booleanValue: true }, empty: { nullValue: null }, nested: { mapValue: { fields: { names: { arrayValue: { values: [{ stringValue: 'Sarin' }, { booleanValue: false }] } } } } } }),
      rawDocument('businesses/missing/appointments/a', { startAt: { integerValue: '1792147200000' } }),
      rawDocument('paymentImages/receipt', { ownerUid: { stringValue: 'owner' }, receiptDataUrl: { stringValue: dataUrl } }),
    ],
  };
}

describe('Firestore migration artifacts', () => {
  it('restores cursor anchors and own appointments into D1 without any pagination state documents', async () => {
    const memory = memoryFirestore();
    await seedPagination(memory.db, Array.from({ length: 25 }, (_, i) => paginationAppointment(`demo-page-${String(i).padStart(3, '0')}`)));
    const first = await readClientAppointmentsPage(paginationActor, paginationBusiness, { version: 1, view: 'upcoming' }, memory.db, paginationNow);
    const source = { ...snapshot(), documents: [...memory.rows].map(([path, row]) => rawDocument(path, Object.fromEntries(Object.entries(row.data).map(([key, value]) => [key, encodeFirestoreValue(value)])))) };
    const bundle = prepareMigration(source, { updatedAt: paginationNow });
    const runtime = await createDataTestRuntime();
    try {
      await runtime.db.exec(buildImportSql(bundle));
      const restored = createCloudflareDatabase(async command => {
        const response = await runtime.fetch(command), result = await response.json() as DataReadResult | DataCommitResult;
        if (!response.ok) throw new StorageError(response.status, 'DATA_UNAVAILABLE'); return result;
      });
      const page = await readClientAppointmentsPage(paginationActor, paginationBusiness, { version: 1, view: 'upcoming', cursor: first.nextCursor! }, restored, paginationNow);
      expect(page.rows.map(row => row.id)).toEqual(['demo-page-020', 'demo-page-021', 'demo-page-022', 'demo-page-023', 'demo-page-024']);
      expect(await readClientAppointment(paginationActor, paginationBusiness, 'demo-page-024', restored)).toEqual(paginationAppointment('demo-page-024'));
      expect(bundle.rows).toHaveLength(26);
    } finally { await runtime.dispose(); }
  }, 60000);
  it('restores quota attempts receipts reviews and original periods into empty D1 without reauthorizing dispatch', async () => {
    const { vi } = await import('vitest');
    const clock = vi.spyOn(Date, 'now').mockReturnValue(quotaStorageNow); vi.stubEnv('SUPERADMIN_UID', 'demo-admin');
    const memory = memoryFirestore(); let runtime: Awaited<ReturnType<typeof createDataTestRuntime>> | undefined;
    try {
      const settled = await quotaStorageSetup(memory.db);
      await markResponseQuotaDispatch(settled.reservation, quotaStorageInput.fingerprint, { providerCallId: null }, memory.db);
      await reconcileResponseQuota({ uid: 'demo-admin' }, { requestId: 'demo-backup-review', reservation: settled.reservation, expectedFingerprint: quotaStorageInput.fingerprint, resolution: 'consume', reason: 'Synthetic evidence only', evidenceSha256: 'b'.repeat(64) }, memory.db);
      const pendingInput = { ...quotaStorageInput, requestId: 'demo-pending' };
      const pending = await reserveResponseQuota(pendingInput, memory.db, undefined, { deadlineAt: quotaStorageNow + 1000 });
      await markResponseQuotaDispatch(pending.reservation, pendingInput.fingerprint, { providerCallId: null }, memory.db);
      const legacy = await reserveResponseQuota({ ...quotaStorageInput, requestId: 'demo-legacy-held' }, memory.db, undefined, { deadlineAt: quotaStorageNow + 1000 });
      const legacyRef = memory.db.collection('responseQuotaTurns').doc(legacy.reservation.reservationId);
      const { execution: _execution, nextAttemptAt: _next, ...oldTurn } = (await legacyRef.get()).data()!;
      await legacyRef.set(oldTurn);
      const documents = [...memory.rows].map(([path, row]) => rawDocument(path, Object.fromEntries(Object.entries(row.data).map(([key, value]) => [key, encodeFirestoreValue(value)]))));
      for (const [path, row] of memory.rows) expect(() => classifyBackupDocument(path, row.data, quotaStorageNow), path).not.toThrow();
      const source = { ...snapshot(), documents, collections: [...new Set(documents.map(row => row.name.slice(prefix.length).split('/').slice(0, -1).join('/')))], missingAncestors: [] };
      const bundle = prepareMigration(source, { updatedAt: quotaStorageNow });
      runtime = await createDataTestRuntime({ quotaRecovery: true });
      await runtime.db.exec(buildImportSql(bundle));
      const rows = (await runtime.db.prepare('SELECT * FROM app_documents ORDER BY path').all()).results;
      expect(verifyImportedRows(bundle, rows).documents).toBe(bundle.rows.length);
      expect(rows.filter((row: { path: string }) => row.path.startsWith('responseQuotaReceipts/'))).toHaveLength(1);
      expect(rows.filter((row: { path: string }) => row.path.includes('/reviews/'))).toHaveLength(1);
      const restored = createCloudflareDatabase(async command => {
        const response = await runtime!.fetch(command), data = await response.json() as DataReadResult | DataCommitResult;
        if (!response.ok) throw new StorageError(response.status, (data as unknown as { code: string }).code); return data;
      });
      expect((await reserveResponseQuota(quotaStorageInput, restored, undefined, { deadlineAt: quotaStorageNow + 2000 })).kind).toBe('replay');
      expect(await markResponseQuotaDispatch(pending.reservation, pendingInput.fingerprint, { providerCallId: null }, restored)).toBe('already_marked');
      const recovery = await runtime.recoverQuota!(quotaStorageNow + 2000); expect(recovery.status).toBe(200);
      const periodRef = restored.collection('responseQuotaScopes').doc(settled.reservation.scopeId).collection('periods').doc(settled.reservation.periodId);
      expect((await periodRef.get()).data()).toMatchObject({ usedResponses: 2, reservedResponses: 1 });
      expect((await restored.collection('responseQuotaReceipts').get()).size).toBe(2);
      expect((await restored.collection('responseQuotaTurns').doc(legacy.reservation.reservationId).get()).data()).toMatchObject({ status: 'reserved', execution: { origin: 'legacy_unknown' } });
      const legacyReview = { requestId: 'demo-legacy-review', reservation: legacy.reservation, expectedFingerprint: quotaStorageInput.fingerprint, resolution: 'consume' as const, reason: 'Synthetic legacy evidence', evidenceSha256: 'c'.repeat(64) };
      await reconcileResponseQuota({ uid: 'demo-admin' }, legacyReview, restored);
      await reconcileResponseQuota({ uid: 'demo-admin' }, legacyReview, restored);
      expect((await periodRef.get()).data()).toMatchObject({ usedResponses: 3, reservedResponses: 0 });
      expect((await restored.collection('responseQuotaReceipts').get()).size).toBe(3);
      const reverse = buildReversePlan({ baseline: source, rows, blobs: [], revision: 0 });
      expect(reverse.deletionCandidates).toEqual([]);
      const roundtrip = prepareMigration({ ...source, documents: reverse.upserts.map((write: { update: { name: string; fields: Record<string, unknown> } }) => ({ ...write.update, createTime: stamp, updateTime: stamp })) }, { updatedAt: quotaStorageNow });
      expect(roundtrip.rows).toEqual(bundle.rows);
    } finally { await runtime?.dispose(); clock.mockRestore(); vi.unstubAllEnvs(); }
  }, 60000);
  it('a receipt-unaware Worker allowlist rejects a settlement batch without any partial write', async () => {
    const memory = memoryFirestore(), { vi } = await import('vitest'), clock = vi.spyOn(Date, 'now').mockReturnValue(quotaStorageNow);
    let runtime: Awaited<ReturnType<typeof createDataTestRuntime>> | undefined;
    try {
      const quota = await quotaStorageSetup(memory.db);
      await markResponseQuotaDispatch(quota.reservation, quotaStorageInput.fingerprint, { providerCallId: null }, memory.db);
      const { prepareResponseQuotaSettlement } = await import('@/lib/server/response-quota-store');
      const stage = await memory.db.runTransaction(tx => prepareResponseQuotaSettlement(tx, memory.db, { quotaTurnId: quota.reservation.reservationId, expectedFingerprint: quotaStorageInput.fingerprint, expectedScopeId: quota.reservation.scopeId, reservation: quota.reservation }, true, { kind: 'dispatch_possible' }, quotaStorageNow));
      runtime = await createDataTestRuntime({ previousQuotaRecords: true });
      const response = await runtime.fetch({ action: 'commit', expectedRevision: 0, requestId: crypto.randomUUID(), writes: stage.writes });
      expect(response.status).toBe(400);
      expect((await runtime.db.prepare('SELECT COUNT(*) AS count FROM app_documents').first()).count).toBe(0);
      expect((await runtime.db.prepare('SELECT revision FROM app_revision WHERE id=1').first()).revision).toBe(0);
    } finally { await runtime?.dispose(); clock.mockRestore(); }
  }, 60000);
  it('preserves attendance and prepared closed applied owner reschedule proofs through snapshot reverse reconciliation and actual SQL R2 backup recovery', async () => {
    const memory = memoryFirestore(), f = await attendanceFixture(memory.db);
    // Use real domain-produced audit documents; keep all data synthetic.
    const { vi } = await import('vitest');
    const clock = vi.spyOn(Date, 'now').mockReturnValue(attendanceNow);
    const encodeRow = ([path, row]: [string, { data: Record<string, unknown> }]) => rawDocument(path, Object.fromEntries(Object.entries(row.data).map(([key, value]) => [key, encodeFirestoreValue(value)])));
    let runtime: Awaited<ReturnType<typeof createDataTestRuntime>> | undefined;
    const directory = await mkdtemp(join(tmpdir(), 'sarin-migration-fixture-'));
    try {
      await updateAppointmentAttendance(f.owner, f.business.id, f.appointment.id, f.command, memory.db);
      clock.mockReturnValue(ownerRescheduleNow);
      await seedOwnerRescheduleScenario(memory.db);
      const prepareOwner = async (requestId: string, startTimeStr: string) => {
        const source = await readOwnerRescheduleSource(ownerRescheduleActor, ownerRescheduleBusiness.id, ownerRescheduleSource.id, memory.db);
        return (await prepareOwnerReschedule(ownerRescheduleActor, ownerRescheduleBusiness.id, ownerRescheduleSource.id, { ...source.expectation, requestId, selection: { ...ownerRescheduleSelection, startTimeStr } }, memory.db)).proposal;
      };
      const applied = await prepareOwner('demo-backup-applied', '10:00');
      await confirmOwnerReschedule(ownerRescheduleActor, ownerRescheduleBusiness.id, applied.id, memory.db);
      await prepareOwner('demo-backup-prepared', '11:00');
      const closed = await prepareOwner('demo-backup-closed', '12:00');
      clock.mockReturnValue(ownerRescheduleNow + 600001);
      await expect(confirmOwnerReschedule(ownerRescheduleActor, ownerRescheduleBusiness.id, closed.id, memory.db)).rejects.toMatchObject({ code: 'OWNER_RESCHEDULE_PROPOSAL_CLOSED' });
      clock.mockReturnValue(factualFaqNow);
      const faq = await seedFactualFaqScenario(memory.db);
      await saveOwnerFactualFaq(faq.owner, faq.business.id, { requestId: 'demo-backup-faq', expectedRevision: 0, expectedPolicyRevision: 1, items: syntheticFaqItems }, memory.db);
      clock.mockReturnValue(attendanceNow);
      const baseline = { ...snapshot(), documents: [...snapshot().documents, ...[...memory.rows].map(encodeRow)] };
      await updateAppointmentAttendance(f.owner, f.business.id, f.appointment.id, attendanceCorrectionCommand, memory.db);
      const current = { ...snapshot(), documents: [...snapshot().documents, ...[...memory.rows].map(encodeRow)] };
      for (const [path, row] of memory.rows) {
        const { historicalMetadata, ...known } = row.data;
        if (historicalMetadata) expect(() => classifyBackupDocument(path, row.data, attendanceNow), path).toThrow('D1_BACKUP_UNCLASSIFIED');
        expect(() => classifyBackupDocument(path, known, attendanceNow), path).not.toThrow();
      }
      const bundle = prepareMigration(current, { updatedAt: attendanceNow });
      runtime = await createDataTestRuntime();
      await runtime.db.exec(buildImportSql(bundle));
      for (const blob of bundle.blobs) await runtime.bucket.put(blob.key, blob.bytes, { httpMetadata: { contentType: blob.contentType } });
      const rows = (await runtime.db.prepare('SELECT * FROM app_documents ORDER BY path').all()).results;
      expect(verifyImportedRows(bundle, rows).documents).toBe(bundle.rows.length);
      const plan = buildReversePlan({ baseline, rows, blobs: bundle.blobs, revision: 0 });
      expect(plan.deletionCandidates).toEqual([]);
      const eventWrites = plan.upserts.filter((write: { update: { name: string } }) => write.update.name.includes('/attendanceEvents/'));
      expect(eventWrites).toHaveLength(2);
      expect(eventWrites.map((write: { currentDocument: unknown }) => write.currentDocument)).toContainEqual({ exists: false });
      const roundtrip = prepareMigration({ ...current, documents: plan.upserts.map((write: { update: { name: string; fields: Record<string, unknown> } }) => ({ ...write.update, createTime: stamp, updateTime: stamp })) }, { updatedAt: attendanceNow });
      expect(roundtrip.rows).toEqual(bundle.rows);
      const faqRows = bundle.rows.filter((row: { path: string }) => /\/factualFaq(?:Operations)?\//.test(row.path));
      expect(faqRows).toHaveLength(2);
      expect(faqRows.find((row: { path: string }) => row.path.includes('/factualFaq/')).data.items).toEqual(syntheticFaqItems);
      expect(faqRows.find((row: { path: string }) => row.path.includes('/factualFaqOperations/')).data.applied.commandFingerprint).toMatch(/^[a-f0-9]{64}$/);
      const ownerProofs = bundle.rows.filter((row: { path: string }) => row.path.includes('/ownerRescheduleProposals/'));
      expect(ownerProofs.map((row: { data: { state: string } }) => row.data.state).sort()).toEqual(['applied', 'closed', 'prepared']);
      for (const row of ownerProofs) {
        expect(row.data.commandFingerprint).toMatch(/^[a-f0-9]{64}$/); expect(row.data.sourceFingerprint).toMatch(/^[a-f0-9]{64}$/);
        expect(row.data.catalogFingerprint).toMatch(/^[a-f0-9]{64}$/); expect(row.data.resourceScheduleFingerprint).toMatch(/^[a-f0-9]{64}$/);
        expect(row.data.actorUid).toBe(ownerRescheduleActor.uid); expect(row.data).not.toHaveProperty('client');
      }
      expect(bundle.rows.find((row: { path: string }) => row.path === `businesses/${ownerRescheduleBusiness.id}/appointments/${ownerRescheduleSource.id}`).data).toMatchObject({ rescheduleRevision: 1, lastRescheduleProposalId: applied.id });
      const events = bundle.rows.filter((row: { path: string }) => row.path.includes('/attendanceEvents/')).sort((a: { data: { sequence: number } }, b: { data: { sequence: number } }) => a.data.sequence - b.data.sequence);
      expect(events.map((row: { data: { sequence: number } }) => row.data.sequence)).toEqual([1, 2]);
      for (const event of events) {
        expect(event.data.actorUid === f.owner.uid).toBe(true);
        expect(event.data.requestFingerprint).toMatch(/^[a-f0-9]{64}$/);
      }
      const migrations = new URL('../cloudflare/migrations/', import.meta.url);
      const schema = (await Promise.all((await readdir(migrations)).filter(name => /^\d+.*\.sql$/.test(name)).sort().map(name => readFile(new URL(name, migrations), 'utf8')))).join('\n');
      const sqlBytes = Buffer.from(`${schema}\n${buildImportSql(bundle)}`), sqlHash = sha256(sqlBytes);
      await writeFile(join(directory, 'sarin-bot-data.sql'), sqlBytes);
      await writeFile(join(directory, 'export-manifest.json'), JSON.stringify({ ok: true, filename: 'sarin-bot-data.sql', sha256: sqlHash, bytes: sqlBytes.length }));
      await mkdir(join(directory, 'r2-objects'));
      for (const blob of bundle.blobs) await writeFile(join(directory, 'r2-objects', blob.sha256), blob.bytes);
      await writeFile(join(directory, 'r2-backup-manifest.json'), JSON.stringify({ sourceSqlSha256: sqlHash, bucket: 'sarin-bot-files', references: bundle.manifest.blobs }));
      let inspected = false;
      const recovered = await verifyD1Backup(directory, { inspectLocal: async ({ db, bucket }: any) => {
        expect((await db.prepare('SELECT count(*) AS count FROM app_documents').first()).count).toBe(bundle.rows.length);
        expect(await bucket.get(bundle.blobs[0].key)).not.toBeNull();
        inspected = true;
      } });
      expect(inspected).toBe(true);
      expect(recovered).toMatchObject({ ok: true, localOnly: true, dataPrinted: false, remoteMutations: false, integrity: 'ok', tables: { app_documents: { count: bundle.rows.length }, app_commits: { count: 0 }, app_revision: { count: 1 } }, r2: { objects: 1, verified: true } });
      expect(recovered.schema.count).toBe((await runtime.db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE tbl_name IN ('app_commits','app_documents','app_revision') AND name NOT LIKE 'sqlite_%'").all()).results.length);
    } finally {
      clock.mockRestore(); await runtime?.dispose();
      expect(dirname(resolve(directory))).toBe(resolve(tmpdir())); expect(basename(directory).startsWith('sarin-migration-fixture-')).toBe(true);
      await rm(directory, { recursive: true, force: true });
    }
  }, 60000);
  it('preserves both R2 prefixes with identical bytes and reopens old-style hash-named files', async () => {
    const bytes = webp(), source = snapshot();
    source.documents.push(logoDocument(bytes), rawDocument('paymentImages/shared', { receiptDataUrl: { stringValue: `data:image/webp;base64,${bytes.toString('base64')}` } }));
    const bundle = prepareMigration(source, { updatedAt: 1000 });
    expect(bundle.blobs.filter((blob: { sha256: string }) => blob.sha256 === sha256(bytes)).map((blob: { key: string }) => blob.key).sort()).toEqual([`business-logos/${sha256(bytes)}`, `payment-images/${sha256(bytes)}`]);
    expect(verifyMigration(bundle).blobs).toBe(3);
    const directory = await mkdtemp(join(tmpdir(), 'sarin-migration-fixture-'));
    try {
      await writeSourceBackup(directory, source);
      await writePreparedBundle(directory, bundle);
      expect(verifyMigration(await readPreparedBundle(directory)).blobs).toBe(3);
    } finally {
      expect(dirname(resolve(directory))).toBe(resolve(tmpdir()));
      expect(basename(directory).startsWith('sarin-migration-fixture-')).toBe(true);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('roundtrips large logos through real D1/R2 and a local SQL backup recovery', async () => {
    const bytes = webp(151 * 1024), source = snapshot();
    source.documents.push(logoDocument(bytes));
    const bundle = prepareMigration(source, { updatedAt: 1000 });
    const directory = await mkdtemp(join(tmpdir(), 'sarin-migration-fixture-'));
    const runtime = await createDataTestRuntime();
    try {
      for (const blob of bundle.blobs) await runtime.bucket.put(blob.key, blob.bytes, { httpMetadata: { contentType: blob.contentType } });
      const schema = await readFile(new URL('../cloudflare/migrations/0001_data.sql', import.meta.url), 'utf8');
      const sql = `${schema}\n${buildImportSql(bundle)}`;
      await runtime.db.exec(buildImportSql(bundle));
      const rows = (await runtime.db.prepare('SELECT * FROM app_documents ORDER BY path').all()).results;
      expect(verifyImportedRows(bundle, rows).documents).toBe(4);
      const path = `businessLogos/owner_${sha256(bytes)}`;
      const hydrated = await runtime.fetch({ action: 'read', read: { kind: 'document', path } });
      expect((await hydrated.json()).documents[0].data.logoDataUrl).toBe(`data:image/webp;base64,${bytes.toString('base64')}`);
      const plan = buildReversePlan({ baseline: source, rows, blobs: bundle.blobs, revision: 0 });
      const restored = plan.upserts.find((write: { update: { name: string } }) => write.update.name.endsWith(path));
      expect(restored.update.fields.logoDataUrl).toEqual(source.documents.at(-1)!.fields.logoDataUrl);
      expect(restored.update.fields.receiptDataUrl).toBeUndefined();
      const sqlBytes = Buffer.from(sql), sqlHash = sha256(sqlBytes);
      await writeFile(join(directory, 'sarin-bot-data.sql'), sqlBytes);
      await writeFile(join(directory, 'export-manifest.json'), JSON.stringify({ ok: true, filename: 'sarin-bot-data.sql', sha256: sqlHash, bytes: sqlBytes.length }));
      const { mkdir } = await import('node:fs/promises');
      await mkdir(join(directory, 'r2-objects'));
      for (const blob of bundle.blobs) await writeFile(join(directory, 'r2-objects', blob.sha256), blob.bytes);
      await writeFile(join(directory, 'r2-backup-manifest.json'), JSON.stringify({ sourceSqlSha256: sqlHash, bucket: 'sarin-bot-files', references: bundle.manifest.blobs }));
      expect(await verifyD1Backup(directory)).toMatchObject({ ok: true, localOnly: true, r2: { objects: 2, bytes: bytes.length + image.length, verified: true } });
    } finally {
      await runtime.dispose();
      expect(dirname(resolve(directory))).toBe(resolve(tmpdir()));
      expect(basename(directory).startsWith('sarin-migration-fixture-')).toBe(true);
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);

  it('binds blob size, type and digest to the correct collection and rejects restore collisions', () => {
    const bytes = webp(), source = snapshot();
    source.documents.push(logoDocument(bytes));
    const bundle = prepareMigration(source, { updatedAt: 1000 });
    const row = bundle.rows.find((item: { path: string }) => item.path.startsWith('businessLogos/'));
    for (const changed of [
      { ...row, blob: { ...row.blob, key: `payment-images/${sha256(bytes)}` } },
      { ...row, blob: { ...row.blob, contentType: 'image/png' } },
      { ...row, blob: { ...row.blob, byteLength: 256 * 1024 + 1 } },
      { ...row, data: { ...row.data, sha256: 'a'.repeat(64) } },
      { ...row, path: `businessLogos/other_${sha256(bytes)}`, document_id: `other_${sha256(bytes)}` },
      { ...row, path: 'users/owner', parent: 'users', document_id: 'owner' },
    ]) expect(() => normalizeImportedRow(changed)).toThrow(/ROW_BLOB/);
    expect(() => buildReversePlan({ baseline: source, rows: [{ ...row, data: { ...row.data, logoDataUrl: 'collision' } }], blobs: bundle.blobs, revision: 0 })).toThrow(/RESTORE_BLOB_COLLISION/);
    for (const invalid of [image, webp(256 * 1024 + 1)]) {
      const input = snapshot(); input.documents.push(logoDocument(invalid));
      expect(() => prepareMigration(input)).toThrow(/IMAGE_/);
    }
    const receipt = snapshot(); receipt.documents.push(rawDocument('paymentImages/too_large', { receiptDataUrl: { stringValue: `data:image/webp;base64,${webp(151 * 1024).toString('base64')}` } }));
    expect(() => prepareMigration(receipt)).toThrow(/IMAGE_BYTES/);
  });

  it('decodes only exactly representable JSON types and rejects unsupported values without printing contents', () => {
    expect(decodeFirestoreValue({ integerValue: '9007199254740991' })).toBe(Number.MAX_SAFE_INTEGER);
    expect(decodeFirestoreValue({ mapValue: {} })).toEqual({});
    expect(decodeFirestoreValue({ arrayValue: {} })).toEqual([]);
    for (const value of [{ integerValue: '9007199254740992' }, { doubleValue: 'NaN' }, { doubleValue: Infinity }, { doubleValue: -0 }, { timestampValue: stamp }, { bytesValue: 'cHJpdmF0ZQ==' }, { referenceValue: 'private/reference' }, { geoPointValue: { latitude: 1, longitude: 2 } }, { stringValue: 'private', booleanValue: true }]) {
      expect(() => decodeFirestoreValue(value)).toThrow(/MIGRATION_/);
      try { decodeFirestoreValue(value); } catch (error) { expect(String(error)).not.toContain('private'); }
    }
  });

  it('exports collection and document pagination recursively through missing ancestors at one read time', async () => {
    const calls: { url: URL; body: Record<string, unknown> }[] = [];
    const request = async (url: string, options: { body?: Record<string, unknown> }) => {
      const parsed = new URL(url), body = options.body ?? {};
      calls.push({ url: parsed, body });
      const pathname = decodeURIComponent(parsed.pathname);
      if (pathname.endsWith('/documents:listCollectionIds')) return body.pageToken ? { collectionIds: ['empty'] } : { collectionIds: ['businesses'], nextPageToken: 'root+next' };
      if (pathname.endsWith('/documents/businesses')) return parsed.searchParams.get('pageToken') ? { documents: [rawDocument('businesses/real', { name: { stringValue: 'business' } })] } : { documents: [{ name: `${prefix}businesses/missing` }], nextPageToken: 'docs/next' };
      if (pathname.endsWith('/documents/businesses/missing:listCollectionIds')) return { collectionIds: ['appointments'] };
      if (pathname.endsWith('/documents/businesses/missing/appointments')) return { documents: [rawDocument('businesses/missing/appointments/a', {})] };
      return pathname.endsWith(':listCollectionIds') ? {} : { documents: [] };
    };
    const exported = await collectFirestoreDocuments({ request, readTime: stamp });
    expect(exported.documents.map((document: { name: string }) => document.name)).toEqual([`${prefix}businesses/missing/appointments/a`, `${prefix}businesses/real`]);
    expect(exported.missingAncestors).toEqual(['businesses/missing']);
    for (const call of calls) {
      if (call.url.pathname.endsWith(':listCollectionIds')) expect(call.body.readTime).toBe(stamp);
      else { expect(call.url.searchParams.get('showMissing')).toBe('true'); expect(call.url.searchParams.get('readTime')).toBe(stamp); }
    }
  });

  it('fails on repeated pagination tokens, cross-project names and duplicate conflicting documents', async () => {
    await expect(collectFirestoreDocuments({ readTime: stamp, request: async () => ({ collectionIds: ['businesses'], nextPageToken: 'repeat' }) })).rejects.toThrow(/PAGINATION/);
    await expect(collectFirestoreDocuments({ readTime: stamp, request: async (url: string) => url.endsWith(':listCollectionIds') ? { collectionIds: ['businesses'] } : { documents: [{ ...rawDocument('businesses/a', {}), name: 'projects/other/databases/(default)/documents/businesses/a' }] } })).rejects.toThrow(/DOCUMENT_NAME/);
  });

  it('uses the server snapshot after the last drained write, including a write within the previous second', async () => {
    const serverTime = '2026-10-16T12:00:01.500000Z';
    const lastWrite = '2026-10-16T12:00:01.250000Z';
    const request = async (url: string, options: { body?: Record<string, unknown> }) => {
      if (url.endsWith(':runQuery')) {
        expect(options.body).toEqual({ structuredQuery: { select: { fields: [{ fieldPath: '__name__' }] }, from: [{ collectionId: 'users' }], limit: 1 } });
        return [{ readTime: serverTime }]; // An empty users query still supplies a server readTime.
      }
      const parsed = new URL(url), pathname = decodeURIComponent(parsed.pathname);
      if (pathname.endsWith('/documents:listCollectionIds')) { expect(options.body?.readTime).toBe(serverTime); return { collectionIds: ['users'] }; }
      if (pathname.endsWith('/documents/users')) return { documents: Date.parse(parsed.searchParams.get('readTime')!) >= Date.parse(lastWrite) ? [{ ...rawDocument('users/last', {}), updateTime: lastWrite }] : [] };
      return {};
    };
    const exported = await captureFirestoreSnapshot({ request });
    expect(exported.documents).toHaveLength(1);
    expect(exported.readTime).toBe(serverTime);
    expect(exported.snapshotBoundary).toBe('firestore-server-read-time');
    await expect(captureFirestoreSnapshot({ request: async () => [] })).rejects.toThrow('MIGRATION_SERVER_READ_TIME');
  });

  it('extracts canonical proof bytes with a hash reference and verifies every artifact', () => {
    const bundle = prepareMigration(snapshot(), { updatedAt: 1000 });
    expect(bundle.rows).toHaveLength(3);
    const receipt = bundle.rows.find((row: { path: string }) => row.path === 'paymentImages/receipt');
    expect(receipt?.data).toEqual({ ownerUid: 'owner' });
    expect(receipt?.blob).toEqual({ key: `payment-images/${sha256(image)}`, contentType: 'image/png', byteLength: 12, sha256: sha256(image) });
    expect(bundle.blobs[0].bytes.equals(image)).toBe(true);
    expect(verifyMigration(bundle)).toEqual({ documents: 3, blobs: 1, bytes: 12, sha256: bundle.manifest.sha256 });
    const tampered = { ...bundle, blobs: [{ ...bundle.blobs[0], bytes: Buffer.from('tampered') }] };
    expect(() => verifyMigration(tampered)).toThrow(/HASH|BLOB/);
  });

  it('extracts legacy inline receipt images without duplicating identical R2 bytes', () => {
    const source = snapshot();
    source.documents.push(rawDocument('paymentReceipts/legacy', { ownerUid: { stringValue: 'owner' }, receiptDataUrl: { stringValue: dataUrl } }));
    const bundle = prepareMigration(source, { updatedAt: 1000 });
    expect(bundle.blobs).toHaveLength(1);
    expect(bundle.rows.find((row: { path: string }) => row.path === 'paymentReceipts/legacy')?.blob?.sha256).toBe(sha256(image));
  });

  it('rejects every path or JSON shape unavailable through the shared runtime protocol before import', () => {
    for (const path of ['businesses/a/appointments/b/more/c', `users/${'a'.repeat(129)}`, 'unrecognized/a']) {
      const source = snapshot();
      source.documents.push(rawDocument(path, {}));
      expect(() => prepareMigration(source)).toThrow('MIGRATION_RUNTIME_COMPATIBILITY');
    }
    const source = snapshot();
    source.documents.push(rawDocument('users/unsafe', { constructor: { stringValue: 'private' } }));
    expect(() => prepareMigration(source)).toThrow('MIGRATION_RUNTIME_COMPATIBILITY');
    source.documents = [rawDocument('users/large', { body: { stringValue: 'x'.repeat(1024 * 1024) } })];
    expect(() => prepareMigration(source)).toThrow('MIGRATION_RUNTIME_COMPATIBILITY');
    const bundle = prepareMigration(snapshot());
    expect(bundle.manifest.runtimeCompatibility).toEqual({ documents: 3, allCompatible: true });
  });

  it('reports unresolved reservation counts without identities or content', () => {
    const source = snapshot();
    source.documents.push(rawDocument('responseQuotaTurns/private_reservation', { status: { stringValue: 'reserved' } }));
    source.documents.push(rawDocument('responseQuotaScopes/private_scope/periods/one', { reservedResponses: { integerValue: '2' } }));
    const bundle = prepareMigration(source);
    expect(bundle.manifest.counts).toMatchObject({ statusReserved: 1, reservedResponses: 2, reservedResponseDocuments: 1 });
    expect(canonicalJson(bundle.manifest.counts)).not.toContain('private');
  });

  it('writes immutable private artifacts outside the workspace and detects altered SQL or restore files', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sarin-migration-fixture-'));
    try {
      await expect(resolveBackupDirectory(join(process.cwd(), 'work', 'forbidden'))).rejects.toThrow(/INSIDE_WORKSPACE/);
      const source = snapshot(), bundle = prepareMigration(source, { updatedAt: 1000 });
      await writeSourceBackup(directory, source);
      await writePreparedBundle(directory, bundle);
      expect(verifyMigration(await readPreparedBundle(directory)).documents).toBe(3);
      await expect(writePreparedBundle(directory, bundle)).rejects.toThrow();
      const sql = await readFile(join(directory, 'import.sql'));
      await writeFile(join(directory, 'import.sql'), 'SELECT 1;');
      await expect(readPreparedBundle(directory)).rejects.toThrow(/SQL_HASH/);
      await writeFile(join(directory, 'import.sql'), sql);
      await writeFile(join(directory, 'baseline-restore.json'), '{}');
      await expect(readPreparedBundle(directory)).rejects.toThrow(/RESTORE_HASH/);
    } finally {
      expect(dirname(resolve(directory))).toBe(resolve(tmpdir()));
      expect(basename(directory).startsWith('sarin-migration-fixture-')).toBe(true);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('creates and reopens a private backup directory using only the current operator permissions', async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'sarin-migration-fixture-'));
    const directory = join(temporary, 'private');
    try {
      await privateDirectory(directory, { create: true });
      await writeFile(join(directory, 'synthetic.txt'), 'synthetic', { mode: 0o600 });
      await privateDirectory(directory);
      expect(await readFile(join(directory, 'synthetic.txt'), 'utf8')).toBe('synthetic');
      await privateDirectory(directory);
      if (process.platform === 'win32') {
        const { execFileSync } = await import('node:child_process');
        const code = "$backupAcl=Get-Acl -LiteralPath ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + Buffer.from(directory).toString('base64') + "'))); $backupSid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $backupRules=@($backupAcl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])); if(-not $backupAcl.AreAccessRulesProtected -or $backupRules.Count -ne 2 -or @($backupRules | Where-Object {$_.IdentityReference.Value -notin @($backupSid,'S-1-5-18') -or $_.IsInherited -or $_.AccessControlType -ne 'Allow'}).Count -gt 0){exit 1}; 'private'";
        expect(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', code], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim()).toBe('private');
      }
    } finally {
      expect(dirname(resolve(temporary))).toBe(resolve(tmpdir()));
      expect(basename(temporary).startsWith('sarin-migration-fixture-')).toBe(true);
      await rm(temporary, { recursive: true, force: true });
    }
  });

  it('generates executable SQL with literal quoting and rejects a nonempty import target', () => {
    const bundle = prepareMigration(snapshot(), { updatedAt: 1000 });
    const sql = buildImportSql(bundle);
    const db = new DatabaseSync(':memory:');
    try {
      db.exec('CREATE TABLE app_documents(path TEXT PRIMARY KEY,parent TEXT,document_id TEXT,data TEXT,updated_at INTEGER,blob TEXT); CREATE TABLE app_revision(id INTEGER PRIMARY KEY,revision INTEGER); INSERT INTO app_revision VALUES(1,0); CREATE TABLE app_commits(request_id TEXT PRIMARY KEY,fingerprint TEXT,revision INTEGER);');
      db.exec(sql);
      const rows = db.prepare('SELECT * FROM app_documents ORDER BY path').all();
      expect(verifyImportedRows(bundle, rows)).toEqual({ documents: 3, sha256: bundle.manifest.sha256 });
      expect(() => db.exec(sql)).toThrow();
      expect(db.prepare('SELECT COUNT(*) AS count FROM app_documents').get()?.count).toBe(3);
      expect(db.prepare('SELECT revision FROM app_revision WHERE id=1').get()?.revision).toBe(0);
    } finally { db.close(); }
  });

  it('imports the generated SQL and image bytes into real local D1/R2 and reads them through the Worker bridge', async () => {
    const runtime = await createDataTestRuntime();
    try {
      const source = snapshot();
      source.documents.push(rawDocument('paymentReceipts/legacy', { ownerUid: { stringValue: 'owner' }, receiptDataUrl: { stringValue: dataUrl } }));
      const bundle = prepareMigration(source, { updatedAt: 1000 });
      for (const blob of bundle.blobs) await runtime.bucket.put(blob.key, blob.bytes, { httpMetadata: { contentType: blob.contentType } });
      await runtime.db.exec(buildImportSql(bundle));
      const imported = await runtime.db.prepare('SELECT * FROM app_documents ORDER BY path').all();
      expect(verifyImportedRows(bundle, imported.results).documents).toBe(4);
      expect((await runtime.db.prepare('SELECT revision FROM app_revision WHERE id=1').first()).revision).toBe(0);
      expect((await runtime.db.prepare('SELECT count(*) AS count FROM app_commits').first()).count).toBe(0);
      for (const path of ['paymentImages/receipt', 'paymentReceipts/legacy']) {
        const response = await runtime.fetch({ action: 'read', read: { kind: 'document', path } });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ revision: 0, documents: [{ path, data: { ownerUid: 'owner', receiptDataUrl: dataUrl } }] });
      }
      const bytes = await (await runtime.bucket.get(bundle.blobs[0].key)).arrayBuffer();
      expect(sha256(Buffer.from(bytes))).toBe(bundle.blobs[0].sha256);
      const absent = await runtime.fetch({ action: 'read', read: { kind: 'document', path: 'businesses/missing' } });
      expect(await absent.json()).toEqual({ revision: 0, documents: [] });
      await expect(runtime.db.exec(buildImportSql(bundle))).rejects.toThrow();
    } finally { await runtime.dispose(); }
  }, 20_000);

  it('requires dedicated resources and explicit final maintenance, and renews operator tokens only in memory', async () => {
    expect(() => parseArguments(['--import', '--directory', 'C:/private', '--database', 'sarin-bot-data', '--bucket', 'sarin-bot-files', '--remote'])).toThrow('MIGRATION_MAINTENANCE_REQUIRED');
    expect(() => parseArguments(['--import', '--directory', 'C:/private', '--database', 'other', '--bucket', 'sarin-bot-files'])).toThrow('MIGRATION_DEDICATED_RESOURCES');
    const tokens = ['synthetic-operator-token-one', 'synthetic-operator-token-two'];
    let supplied = 0, calls = 0;
    const request = firestoreRequester({ tokenSupplier: () => tokens[supplied++], fetchImpl: async (...args: Parameters<typeof fetch>) => {
      const options = args[1];
      expect(options?.redirect).toBe('error');
      expect(options?.headers).toMatchObject({ Authorization: `Bearer ${tokens[calls]}` });
      calls += 1;
      return calls === 1 ? new Response('{}', { status: 401 }) : Response.json({ collectionIds: [] });
    } });
    expect(await request(`https://firestore.googleapis.com/v1/${prefix.slice(0, -1)}:listCollectionIds`, { method: 'POST', body: {} })).toEqual({ collectionIds: [] });
    expect(supplied).toBe(2);
    await expect(request('https://example.invalid/private', { method: 'GET' })).rejects.toThrow('MIGRATION_FIRESTORE_DESTINATION');
    await expect(request(`https://firestore.googleapis.com/v1/${prefix}users/private`, { method: 'DELETE' })).rejects.toThrow('MIGRATION_FIRESTORE_DESTINATION');
  });

  it('locates the Windows Google SDK Python entrypoint under lib rather than bin', () => {
    const sdk = resolve(tmpdir(), 'synthetic-google-cloud-sdk');
    const available = new Set([join(sdk, 'platform', 'bundledpython', 'python.exe'), join(sdk, 'lib', 'gcloud.py')]);
    expect(googleCloudSdkCommand(sdk, (file) => available.has(String(file)))).toEqual({ file: join(sdk, 'platform', 'bundledpython', 'python.exe'), arguments: [join(sdk, 'lib', 'gcloud.py')] });
    expect(() => googleCloudSdkCommand(sdk, () => false)).toThrow('MIGRATION_GCLOUD_SDK_MISSING');
  });

  it('reads machine JSON from the installed Wrangler CLI without suppressing stdout', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sarin-migration-fixture-'));
    try {
      await privateDirectory(directory);
      expect(queryD1(directory, { '--database': 'sarin-bot-data' }, 'SELECT 1 AS synthetic;')).toEqual([{ synthetic: 1 }]);
    } finally {
      expect(dirname(resolve(directory))).toBe(resolve(tmpdir()));
      expect(basename(directory).startsWith('sarin-migration-fixture-')).toBe(true);
      await rm(directory, { recursive: true, force: true });
    }
  }, 20_000);

  it('preserves original Firestore field types and image bytes when creating a baseline restore', () => {
    const original = snapshot();
    const writes = restoreFirestoreWrites(original);
    expect(writes.map((write: { update: { name: string; fields: unknown } }) => write.update.fields)).toEqual(original.documents.map(document => document.fields));
    expect(writes[0].currentDocument).toEqual({ updateTime: stamp });
  });

  it('reconciles D1 updates, new documents, deleted paths and R2 images for a guarded rollback plan', () => {
    const baseline = snapshot();
    const bundle = prepareMigration(baseline, { updatedAt: 1000 });
    const rows = bundle.rows.filter((row: { path: string }) => row.path !== 'businesses/missing/appointments/a').map((row: { path: string; data: Record<string, unknown> }) => row.path.startsWith('businesses/') ? { ...row, data: { ...row.data, appointments: 11 } } : row);
    rows.push({ path: 'users/new', parent: 'users', document_id: 'new', data: { uid: 'new', createdAt: 123 }, updated_at: 1001, blob: null });
    const plan = buildReversePlan({ baseline, rows, blobs: bundle.blobs, revision: 7 });
    expect(plan.requiresMaintenance).toBe(true);
    expect(plan.revision).toBe(7);
    expect(plan.upserts).toHaveLength(3);
    const updated = plan.upserts.find((write: { update: { name: string } }) => write.update.name.endsWith('businesses/owner_quoted'));
    expect(updated?.update.fields.appointments).toEqual({ integerValue: '11' });
    expect(updated?.update.fields.exactDouble).toEqual({ doubleValue: 1 });
    const restoredImage = plan.upserts.find((write: { update: { name: string } }) => write.update.name.endsWith('paymentImages/receipt'));
    expect(restoredImage?.update.fields.receiptDataUrl).toEqual({ stringValue: dataUrl });
    expect(plan.deletionCandidates).toEqual([{ delete: `${prefix}businesses/missing/appointments/a`, currentDocument: { updateTime: stamp } }]);
    expect(plan.upserts.find((write: { update: { name: string } }) => write.update.name.endsWith('users/new'))?.currentDocument).toEqual({ exists: false });
  });

  it('hashes canonical maps independently of insertion order and rejects silent JSON coercion', () => {
    expect(canonicalJson({ b: 2, a: { z: 1, c: true } })).toBe('{"a":{"c":true,"z":1},"b":2}');
    for (const value of [{ a: undefined }, { a: NaN }, { a: BigInt(1) }, { a: new Date() }]) expect(() => canonicalJson(value)).toThrow(/MIGRATION_/);
  });
});
