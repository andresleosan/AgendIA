import "server-only";
import {
  applicationDefault,
  cert,
  getApps,
  initializeApp,
  type App,
} from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { readAdminEmulatorConfig } from "@/lib/firebase/emulator-config";
import { createCloudflareDatabase } from "@/lib/storage/database";
import type { Database } from "@/lib/storage/types";
const state = globalThis as typeof globalThis & {
  __sarinAdminConnections?: WeakMap<App, string>;
  __sarinCloudflareDatabase?: Database;
};

function getAdminApp() {
  // Admin SDK automatically accepts unsigned Auth tokens when its emulator
  // environment variable exists. Validate before returning even a cached app.
  const emulator = readAdminEmulatorConfig(process.env);
  const projectId = process.env.FIREBASE_ADMIN_PROJECT_ID;
  if (!projectId) throw new Error("Firebase Admin no está configurado.");
  if (!emulator && projectId.startsWith("demo-"))
    throw new Error("El proyecto demo requiere los emuladores locales.");
  const credentialMode = emulator
    ? "emulator"
    : process.env.FIREBASE_ADMIN_CREDENTIAL_MODE || "cert";
  if (!emulator && !["cert", "adc"].includes(credentialMode))
    throw new Error("El modo de credenciales Firebase Admin debe ser cert o adc.");
  const clientEmail = process.env.FIREBASE_ADMIN_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_ADMIN_PRIVATE_KEY?.replace(
    /\\n/g,
    "\n",
  );
  if (credentialMode === "adc" && (clientEmail || privateKey))
    throw new Error(
      "Configura ADC sin FIREBASE_ADMIN_CLIENT_EMAIL ni FIREBASE_ADMIN_PRIVATE_KEY.",
    );
  const connections = (state.__sarinAdminConnections ??= new WeakMap());
  const fingerprint = JSON.stringify({
    projectId,
    emulator,
    credentialMode,
    credentialSource:
      credentialMode === "adc"
        ? {
            file: process.env.GOOGLE_APPLICATION_CREDENTIALS || null,
            cloudSdkConfig: process.env.CLOUDSDK_CONFIG || null,
            appData: process.env.APPDATA || null,
            home: process.env.HOME || null,
          }
        : null,
  });
  const existing = getApps().find((app) => app.name === "sarin-admin");
  if (existing) {
    if (
      existing.options.projectId !== projectId ||
      connections.get(existing) !== fingerprint
    )
      throw new Error(
        "La configuración Firebase Admin cambió. Reinicia el servidor.",
      );
    return existing;
  }
  if (emulator) {
    const app = initializeApp({ projectId: emulator.projectId }, "sarin-admin");
    connections.set(app, fingerprint);
    return app;
  }
  let credential;
  if (credentialMode === "adc") {
    credential = applicationDefault();
  } else {
    if (!clientEmail || !privateKey)
      throw new Error("Firebase Admin no está configurado.");
    credential = cert({ projectId, clientEmail, privateKey });
  }
  const app = initializeApp(
    { projectId, credential },
    "sarin-admin",
  );
  connections.set(app, fingerprint);
  return app;
}
export function getAdminAuth() {
  return getAuth(getAdminApp());
}
export function getAdminDb(): Database {
  if (process.env.SARIN_RECOVERY_MODE && process.env.SARIN_RECOVERY_MODE !== 'normal' && process.env.SARIN_DATA_BACKEND !== 'd1') throw new Error('La recuperación requiere evidencia independiente de D1.');
  const backend = process.env.SARIN_DATA_BACKEND || "firestore";
  if (backend === "d1") {
    if (process.env.FIRESTORE_EMULATOR_HOST || process.env.FIREBASE_AUTH_EMULATOR_HOST)
      throw new Error("El backend D1 no admite mezclar emuladores Firebase.");
    return state.__sarinCloudflareDatabase ??= createCloudflareDatabase();
  }
  if (backend !== "firestore") throw new Error("El backend de datos no es válido.");
  // The fallback exists only for local emulation and an explicit rollback. No
  // D1 failure ever falls through to this separate source of truth.
  return getFirestore(getAdminApp()) as unknown as Database;
}
