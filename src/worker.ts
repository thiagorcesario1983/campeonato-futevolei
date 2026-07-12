export interface Env {
  DB: KVNamespace;
  ASSETS: Fetcher;
  TELEGRAM_BOT_TOKEN?: string;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store, no-cache, must-revalidate"
    }
  });
}

/* ============================================================
   TELEGRAM
============================================================ */
async function telegramWebhook(request: Request, env: Env): Promise<Response> {
  let update: any;
  try {
    update = await request.json();
  } catch {
    return new Response("Bad request", { status: 400 });
  }

  const message = update?.message;
  const text: string = message?.text || "";
  const chatId = message?.chat?.id;
  const token = env.TELEGRAM_BOT_TOKEN;

  if (chatId && text.startsWith("/start")) {
    const parts = text.trim().split(/\s+/);
    const code = parts[1];

    if (code) {
      try {
        await env.DB.put(`telegram:${code}`, String(chatId));
        if (token) {
          await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              chat_id: chatId,
              text: "✅ Conectado! Você vai receber os jogos da sua dupla aqui automaticamente quando o sorteio for feito."
            })
          });
        }
      } catch (e: any) {
        if (token) {
          await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              chat_id: chatId,
              text: `⚠️ Erro ao salvar ativação: ${e?.message || e}`
            })
          });
        }
      }
    } else if (token) {
      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: "Use o link de ativação enviado pelo organizador do campeonato para se conectar."
        })
      });
    }
  }

  return new Response("OK", { status: 200 });
}

async function telegramSend(request: Request, env: Env): Promise<Response> {
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token) return json({ error: "TELEGRAM_BOT_TOKEN não configurado" }, 500);

  let body: any;
  try {
    body = await request.json();
  } catch {
    return json({ error: "JSON inválido" }, 400);
  }

  const items: { code: string; message: string }[] = Array.isArray(body?.items)
    ? body.items
    : body?.code
    ? [{ code: body.code, message: body.message }]
    : [];

  if (!items.length) return json({ error: "Nenhum item enviado" }, 400);

  const results = [];
  for (const item of items) {
    const chatId = await env.DB.get(`telegram:${item.code}`);
    if (!chatId) {
      results.push({ code: item.code, ok: false, reason: "not_activated" });
      continue;
    }
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: item.message || "" })
      });
      const data: any = await res.json();
      results.push({ code: item.code, ok: !!data.ok, reason: data.ok ? null : data.description || "erro" });
    } catch {
      results.push({ code: item.code, ok: false, reason: "network_error" });
    }
  }

  return json({ results });
}

async function telegramStatus(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const codesParam = url.searchParams.get("codes") || "";
  const codes = codesParam.split(",").map((c) => c.trim()).filter(Boolean);

  const status: Record<string, boolean> = {};
  await Promise.all(
    codes.map(async (code) => {
      const v = await env.DB.get(`telegram:${code}`);
      status[code] = !!v;
    })
  );

  return json({ status });
}

/* ============================================================
   TORNEIOS
============================================================ */
async function getIndex(env: Env): Promise<any[]> {
  try {
    const raw = await env.DB.get("torneios:index");
    if (raw) return JSON.parse(raw);
  } catch {}
  return [];
}

function normEmail(v: unknown): string {
  return String(v || "").trim().toLowerCase();
}

// E-mail fixo usado pelo login de teste ("Acesso de teste", senha 123456) do próprio app.
// Quem entra com essa conta pode ver e editar os torneios de qualquer organizador —
// é o "modo admin" local, pensado pra quem administra o app no seu próprio grupo.
const ADMIN_EMAIL = "admin@local.teste";
function ehAdmin(email: string): boolean {
  return email === ADMIN_EMAIL;
}

async function torneiosSave(request: Request, env: Env): Promise<Response> {
  let body: any;
  try {
    body = await request.json();
  } catch {
    return json({ error: "JSON inválido" }, 400);
  }

  const solicitanteEmail = normEmail(body.ownerEmail);
  if (!solicitanteEmail) return json({ error: "ownerEmail obrigatório" }, 400);

  const id = body.id || crypto.randomUUID();
  const now = new Date().toISOString();
  const index = await getIndex(env);
  const existing = index.find((t: any) => t.id === id);

  // Só o dono original (ou o admin) pode atualizar um torneio já existente.
  if (existing && normEmail(existing.ownerEmail) !== solicitanteEmail && !ehAdmin(solicitanteEmail)) {
    return json({ error: "Sem permissão para alterar este torneio" }, 403);
  }

  const meta = {
    id,
    nome: body.nome || "Torneio sem nome",
    status: body.status || "Criado",
    ownerEmail: existing?.ownerEmail || body.ownerEmail || null,
    ownerName: existing?.ownerName || body.ownerName || null,
    createdAt: existing?.createdAt || now,
    updatedAt: now
  };

  try {
    await env.DB.put(`torneio:${id}`, JSON.stringify({ ...meta, state: body.state }));
    const newIndex = index.filter((t: any) => t.id !== id);
    newIndex.push(meta);
    await env.DB.put("torneios:index", JSON.stringify(newIndex));
  } catch (e: any) {
    return json({ error: "Falha ao salvar", detail: String(e?.message || e) }, 500);
  }

  return json(meta);
}

async function torneiosList(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const solicitanteEmail = normEmail(url.searchParams.get("email"));
  if (!solicitanteEmail) return json({ error: "email obrigatório" }, 400);

  const index = await getIndex(env);
  const meus = ehAdmin(solicitanteEmail)
    ? index
    : index.filter((t: any) => normEmail(t.ownerEmail) === solicitanteEmail);
  return json({ torneios: meus });
}

async function torneiosGet(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const id = url.searchParams.get("id");
  const solicitanteEmail = normEmail(url.searchParams.get("email"));
  if (!id) return json({ error: "id obrigatório" }, 400);
  if (!solicitanteEmail) return json({ error: "email obrigatório" }, 400);

  const raw = await env.DB.get(`torneio:${id}`);
  if (!raw) return json({ error: "não encontrado" }, 404);

  const dados = JSON.parse(raw);
  if (normEmail(dados.ownerEmail) !== solicitanteEmail && !ehAdmin(solicitanteEmail)) {
    return json({ error: "Sem permissão para ver este torneio" }, 403);
  }

  return json(dados);
}

// Rota pública para o "Placar para TV": não exige login/e-mail, só o ID do torneio
// (aleatório, como já era antes). Precisa continuar aberta porque esse link é feito
// pra ser compartilhado e aberto em qualquer tela, sem ninguém logar.
async function torneiosGetPublico(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const id = url.searchParams.get("id");
  if (!id) return json({ error: "id obrigatório" }, 400);

  const raw = await env.DB.get(`torneio:${id}`);
  if (!raw) return json({ error: "não encontrado" }, 404);

  return json(JSON.parse(raw));
}

async function torneiosDelete(request: Request, env: Env): Promise<Response> {
  let id: string | null = null;
  let solicitanteEmail = "";
  try {
    const body: any = await request.json();
    id = body?.id || null;
    solicitanteEmail = normEmail(body?.ownerEmail);
  } catch {}
  const url = new URL(request.url);
  if (!id) id = url.searchParams.get("id");
  if (!solicitanteEmail) solicitanteEmail = normEmail(url.searchParams.get("email"));
  if (!id) return json({ error: "id obrigatório" }, 400);
  if (!solicitanteEmail) return json({ error: "email obrigatório" }, 400);

  const index = await getIndex(env);
  const existing = index.find((t: any) => t.id === id);
  if (existing && normEmail(existing.ownerEmail) !== solicitanteEmail && !ehAdmin(solicitanteEmail)) {
    return json({ error: "Sem permissão para excluir este torneio" }, 403);
  }

  try {
    await env.DB.delete(`torneio:${id}`);
    const newIndex = index.filter((t: any) => t.id !== id);
    await env.DB.put("torneios:index", JSON.stringify(newIndex));
  } catch (e: any) {
    return json({ error: "Falha ao excluir", detail: String(e?.message || e) }, 500);
  }

  return json({ ok: true, id });
}

/* ============================================================
   ROTEAMENTO
============================================================ */
export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (path === "/api/telegram-webhook") {
      return method === "POST" ? telegramWebhook(request, env) : new Response("Method not allowed", { status: 405 });
    }
    if (path === "/api/telegram-send") {
      return method === "POST" ? telegramSend(request, env) : new Response("Method not allowed", { status: 405 });
    }
    if (path === "/api/telegram-status") {
      return telegramStatus(request, env);
    }
    if (path === "/api/torneios-save") {
      return method === "POST" ? torneiosSave(request, env) : new Response("Method not allowed", { status: 405 });
    }
    if (path === "/api/torneios-list") {
      return torneiosList(request, env);
    }
    if (path === "/api/torneios-get") {
      return torneiosGet(request, env);
    }
    if (path === "/api/torneios-tv") {
      return torneiosGetPublico(request, env);
    }
    if (path === "/api/torneios-delete") {
      return method === "POST" || method === "DELETE"
        ? torneiosDelete(request, env)
        : new Response("Method not allowed", { status: 405 });
    }
    if (path.startsWith("/api/")) {
      return new Response("Not found", { status: 404 });
    }

    return env.ASSETS.fetch(request);
  }
};
