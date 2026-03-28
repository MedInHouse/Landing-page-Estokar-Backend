import { randomUUID } from "node:crypto";
import process from "node:process";
import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import admin from "firebase-admin";
import multer from "multer";

dotenv.config();

const requiredEnvVars = [
  "FIREBASE_PROJECT_ID",
  "FIREBASE_CLIENT_EMAIL",
  "FIREBASE_PRIVATE_KEY",
  "FIREBASE_STORAGE_BUCKET",
  "FIREBASE_WEB_API_KEY",
];

const missingEnvVars = requiredEnvVars.filter((key) => !process.env[key]);

if (!admin.apps.length && missingEnvVars.length === 0) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
    }),
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
  });
}

const port = Number(process.env.PORT || 3333);
const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024,
  },
});

app.use(
  cors({
    origin: process.env.CORS_ORIGIN?.split(",").map((value) => value.trim()) || true,
  }),
);
app.use(express.json({ limit: "12mb" }));

function backendNotConfigured() {
  return missingEnvVars.length > 0 || !admin.apps.length;
}

function assertBackendConfigured(response) {
  if (!backendNotConfigured()) {
    return false;
  }

  response.status(503).json({
    message: "Firebase ainda não foi configurado no backend.",
    missingEnvVars,
  });
  return true;
}

function serializeUser(decodedToken) {
  return {
    uid: decodedToken.uid,
    email: decodedToken.email || "",
    name: decodedToken.name || "",
  };
}

async function requireAuth(request, response, next) {
  if (assertBackendConfigured(response)) {
    return;
  }

  const authorization = request.headers.authorization;

  if (!authorization?.startsWith("Bearer ")) {
    response.status(401).json({
      message: "Token de acesso ausente.",
    });
    return;
  }

  try {
    const idToken = authorization.slice("Bearer ".length);
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    request.user = decodedToken;
    next();
  } catch {
    response.status(401).json({
      message: "Token do Firebase inválido ou expirado.",
    });
  }
}

function normalizeUpdatePayload(payload) {
  const featured = Boolean(payload.featured);

  return {
    id: String(payload.id || "").trim(),
    slug: String(payload.slug || "").trim(),
    title: String(payload.title || "").trim(),
    category: String(payload.category || "Funcionalidade").trim(),
    publishedAt: String(payload.publishedAt || "").trim(),
    summary: String(payload.summary || "").trim(),
    content: String(payload.content || "").trim(),
    coverImage: String(payload.coverImage || "").trim(),
    readTime: String(payload.readTime || "2 min de leitura").trim(),
    featured,
    updatedAt: new Date().toISOString(),
  };
}

function validateUpdate(update) {
  const requiredFields = ["id", "slug", "title", "publishedAt", "summary", "content", "coverImage"];
  const missingFields = requiredFields.filter((field) => !update[field]);

  if (missingFields.length > 0) {
    return `Campos obrigatórios ausentes: ${missingFields.join(", ")}.`;
  }

  return null;
}

function buildStoragePublicUrl(filePath, downloadToken) {
  const bucket = admin.storage().bucket();
  return `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(filePath)}?alt=media&token=${downloadToken}`;
}

app.get("/health", (_request, response) => {
  response.json({
    status: "ok",
    service: "estokar-landing-backend",
    firebaseConfigured: !backendNotConfigured(),
    missingEnvVars,
    timestamp: new Date().toISOString(),
  });
});

app.post("/api/auth/login", async (request, response) => {
  if (assertBackendConfigured(response)) {
    return;
  }

  const { email, password } = request.body || {};

  if (!email || !password) {
    response.status(400).json({
      message: "Informe email e senha.",
    });
    return;
  }

  try {
    const authResponse = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${process.env.FIREBASE_WEB_API_KEY}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          email,
          password,
          returnSecureToken: true,
        }),
      },
    );

    if (!authResponse.ok) {
      response.status(401).json({
        message: "Não foi possível autenticar com email e senha.",
      });
      return;
    }

    const data = await authResponse.json();
    const decodedToken = await admin.auth().verifyIdToken(data.idToken);

    response.json({
      token: data.idToken,
      refreshToken: data.refreshToken,
      user: serializeUser(decodedToken),
    });
  } catch (error) {
    response.status(500).json({
      message: "Falha ao autenticar no Firebase.",
      error: error instanceof Error ? error.message : "Erro desconhecido.",
    });
  }
});

app.get("/api/auth/session", requireAuth, async (request, response) => {
  response.json({
    user: serializeUser(request.user),
  });
});

app.get("/api/updates", async (_request, response) => {
  if (assertBackendConfigured(response)) {
    return;
  }

  const snapshot = await admin
    .firestore()
    .collection("updates")
    .orderBy("publishedAt", "desc")
    .get();

  response.json({
    items: snapshot.docs.map((entry) => entry.data()),
  });
});

app.post("/api/uploads", requireAuth, upload.single("file"), async (request, response) => {
  if (!request.file) {
    response.status(400).json({
      message: "Envie uma imagem para continuar.",
    });
    return;
  }

  try {
    const extension = request.file.originalname.includes(".")
      ? request.file.originalname.split(".").pop()
      : "jpg";
    const filePath = `updates/${new Date().toISOString().slice(0, 10)}/${randomUUID()}.${extension}`;
    const downloadToken = randomUUID();
    const bucket = admin.storage().bucket();
    const file = bucket.file(filePath);

    await file.save(request.file.buffer, {
      contentType: request.file.mimetype,
      metadata: {
        firebaseStorageDownloadTokens: downloadToken,
      },
    });

    response.status(201).json({
      url: buildStoragePublicUrl(filePath, downloadToken),
      path: filePath,
    });
  } catch (error) {
    response.status(500).json({
      message: "Não foi possível enviar a imagem ao Firebase Storage.",
      error: error instanceof Error ? error.message : "Erro desconhecido.",
    });
  }
});

app.put("/api/updates/:id", requireAuth, async (request, response) => {
  const update = normalizeUpdatePayload({
    ...request.body,
    id: request.params.id,
  });
  const validationError = validateUpdate(update);

  if (validationError) {
    response.status(400).json({
      message: validationError,
    });
    return;
  }

  const db = admin.firestore();

  try {
    if (update.featured) {
      const featuredSnapshot = await db.collection("updates").where("featured", "==", true).get();
      const batch = db.batch();

      featuredSnapshot.docs.forEach((entry) => {
        if (entry.id !== update.id) {
          batch.set(entry.ref, { ...entry.data(), featured: false }, { merge: true });
        }
      });

      batch.set(db.collection("updates").doc(update.id), update, { merge: true });
      await batch.commit();
    } else {
      await db.collection("updates").doc(update.id).set(update, { merge: true });
    }

    response.json({
      item: update,
    });
  } catch (error) {
    response.status(500).json({
      message: "Não foi possível salvar a atualização no Firestore.",
      error: error instanceof Error ? error.message : "Erro desconhecido.",
    });
  }
});

app.post("/api/updates/import", requireAuth, async (request, response) => {
  const items = Array.isArray(request.body?.items) ? request.body.items : null;

  if (!items) {
    response.status(400).json({
      message: "Envie um array de atualizações para importar.",
    });
    return;
  }

  const normalizedItems = items.map(normalizeUpdatePayload);
  const validationError = normalizedItems.map(validateUpdate).find(Boolean);

  if (validationError) {
    response.status(400).json({
      message: validationError,
    });
    return;
  }

  const db = admin.firestore();
  const snapshot = await db.collection("updates").get();
  const batch = db.batch();

  snapshot.docs.forEach((entry) => {
    batch.delete(entry.ref);
  });

  normalizedItems.forEach((item) => {
    batch.set(db.collection("updates").doc(item.id), item);
  });

  await batch.commit();

  response.json({
    items: normalizedItems,
  });
});

app.delete("/api/updates/:id", requireAuth, async (request, response) => {
  await admin.firestore().collection("updates").doc(request.params.id).delete();
  response.status(204).end();
});

app.delete("/api/updates", requireAuth, async (_request, response) => {
  const snapshot = await admin.firestore().collection("updates").get();
  const batch = admin.firestore().batch();

  snapshot.docs.forEach((entry) => {
    batch.delete(entry.ref);
  });

  await batch.commit();
  response.status(204).end();
});

app.listen(port, () => {
  console.log(`Backend rodando em http://localhost:${port}`);
});
