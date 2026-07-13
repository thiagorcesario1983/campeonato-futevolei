import { connect } from "cloudflare:sockets";

export interface Env {
  DB: KVNamespace;
  ASSETS: Fetcher;
  TELEGRAM_BOT_TOKEN?: string;
  // Credenciais SMTP (Gmail) — configuradas como secrets via `wrangler secret put`,
  // nunca pela tela do app (são credenciais reais, diferente do Google Client ID).
  SMTP_HOST?: string; // ex: smtp.gmail.com
  SMTP_PORT?: string; // ex: "587"
  SMTP_USER?: string; // seu e-mail Gmail completo
  SMTP_PASS?: string; // a "senha de app" de 16 caracteres gerada no Google, não a senha normal
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
   E-MAIL — cliente SMTP direto via socket TCP (sem serviço terceiro).
   Pensado para Gmail: smtp.gmail.com, porta 587, usuário = e-mail completo,
   senha = "Senha de app" de 16 caracteres (não a senha normal da conta —
   o Gmail exige Verificação em 2 Etapas + Senha de app pra permitir isso).
   Credenciais vêm de secrets do Worker (SMTP_HOST/PORT/USER/PASS), nunca da tela do app.
============================================================ */
async function lerRespostaSmtp(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  const dec = new TextDecoder();
  let buf = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const linhas = buf.split("\r\n").filter(Boolean);
    const ultima = linhas[linhas.length - 1] || "";
    // uma resposta SMTP termina na linha "NNN texto" (espaço logo após o código);
    // linhas intermediárias de uma resposta de várias linhas usam "NNN-texto" (hífen)
    if (/^\d{3} /.test(ultima)) break;
  }
  return buf;
}

async function enviarEmail(env: Env, to: string, subject: string, html: string): Promise<boolean> {
  const host = env.SMTP_HOST, user = env.SMTP_USER, pass = env.SMTP_PASS;
  const port = Number(env.SMTP_PORT || "587");
  if (!host || !user || !pass || !to) return false;

  try {
    let socket = connect({ hostname: host, port }, { secureTransport: port === 465 ? "on" : "starttls" });
    let writer = socket.writable.getWriter();
    let reader = socket.readable.getReader();
    const enc = new TextEncoder();

    const enviar = async (texto: string) => {
      await writer.write(enc.encode(texto + "\r\n"));
      return lerRespostaSmtp(reader);
    };
    const checar = (resp: string, codigos: string[]) => {
      if (!codigos.some((c) => resp.includes(c))) {
        throw new Error(`Resposta SMTP inesperada: ${resp.trim()}`);
      }
    };

    checar(await lerRespostaSmtp(reader), ["220"]); // banner de conexão
    checar(await enviar(`EHLO ${host}`), ["250"]);

    if (port !== 465) {
      checar(await enviar("STARTTLS"), ["220"]);
      // eleva a conexão de texto puro para TLS — os streams antigos deixam de valer
      writer.releaseLock();
      reader.releaseLock();
      socket = socket.startTls();
      writer = socket.writable.getWriter();
      reader = socket.readable.getReader();
      checar(await enviar(`EHLO ${host}`), ["250"]);
    }

    checar(await enviar("AUTH LOGIN"), ["334"]);
    checar(await enviar(btoa(user)), ["334"]);
    checar(await enviar(btoa(pass)), ["235"]);

    checar(await enviar(`MAIL FROM:<${user}>`), ["250"]);
    checar(await enviar(`RCPT TO:<${to}>`), ["250", "251"]);
    checar(await enviar("DATA"), ["354"]);

    const dataAtual = new Date().toUTCString();
    const corpo =
      `From: Campeonato Futevôlei <${user}>\r\n` +
      `To: <${to}>\r\n` +
      `Subject: ${subject}\r\n` +
      `Date: ${dataAtual}\r\n` +
      `MIME-Version: 1.0\r\n` +
      `Content-Type: text/html; charset=UTF-8\r\n` +
      `\r\n${html}\r\n.`;
    checar(await enviar(corpo), ["250"]);

    await enviar("QUIT").catch(() => {}); // não é crítico se o QUIT falhar
    writer.releaseLock();
    reader.releaseLock();
    return true;
  } catch (e) {
    console.error("Falha ao enviar e-mail via SMTP:", e);
    return false;
  }
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

// Código sequencial de 10 posições: 6 dígitos de sequência (controlada pelo app, nunca reseta)
// + 4 dígitos do ano de criação. Ex.: 0000012026, 0000022026... Serve como identificador
// legível pra exibir em telas e nas comunicações — o "id" (UUID) continua sendo a chave interna.
async function gerarCodigoTorneio(env: Env): Promise<string> {
  const atual = Number((await env.DB.get("torneios:contador")) || "0");
  const proximo = atual + 1;
  await env.DB.put("torneios:contador", String(proximo));
  const ano = new Date().getFullYear();
  return String(proximo).padStart(6, "0") + String(ano);
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
  const ehNovo = !existing;

  // Só o dono original (ou o admin) pode atualizar um torneio já existente.
  if (existing && normEmail(existing.ownerEmail) !== solicitanteEmail && !ehAdmin(solicitanteEmail)) {
    return json({ error: "Sem permissão para alterar este torneio" }, 403);
  }

  const meta = {
    id,
    codigo: existing ? existing.codigo : await gerarCodigoTorneio(env),
    nome: body.nome || "Torneio sem nome",
    status: body.status || "Criado",
    ownerEmail: existing?.ownerEmail || body.ownerEmail || null,
    ownerName: existing?.ownerName || body.ownerName || null,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    // Aprovação: todo torneio novo nasce "pendente" — o cliente nunca decide isso sozinho.
    // Datas de validade: definidas pelo criador na hora de pedir o torneio; o admin pode
    // ajustá-las depois, na aprovação (rota /api/torneios-aprovar).
    aprovacaoStatus: existing ? existing.aprovacaoStatus : "pendente",
    dataInicio: existing ? existing.dataInicio : (body.dataInicio || null),
    dataFim: existing ? existing.dataFim : (body.dataFim || null)
  };

  try {
    await env.DB.put(`torneio:${id}`, JSON.stringify({ ...meta, state: body.state }));
    const newIndex = index.filter((t: any) => t.id !== id);
    newIndex.push(meta);
    await env.DB.put("torneios:index", JSON.stringify(newIndex));
  } catch (e: any) {
    return json({ error: "Falha ao salvar", detail: String(e?.message || e) }, 500);
  }

  if (ehNovo) {
    const adminEmail = await env.DB.get("config:admin_notification_email");
    if (adminEmail) {
      await enviarEmail(
        env,
        adminEmail,
        `Novo campeonato solicitado [${meta.codigo}]: ${meta.nome}`,
        `<p>Um novo campeonato foi criado e está aguardando aprovação.</p>
         <p><b>Código:</b> ${meta.codigo}<br>
         <b>Nome:</b> ${meta.nome}<br>
         <b>Organizador:</b> ${meta.ownerName || "-"} (${meta.ownerEmail || "-"})<br>
         <b>Início:</b> ${meta.dataInicio || "não informado"}<br>
         <b>Fim:</b> ${meta.dataFim || "não informado"}</p>
         <p>Entre no app com a conta admin, aba Aprovações, pra revisar.</p>`
      );
    }
    if (meta.ownerEmail) {
      await enviarEmail(
        env,
        meta.ownerEmail,
        `Seu campeonato [${meta.codigo}] "${meta.nome}" foi solicitado`,
        `<p>Olá${meta.ownerName ? ", " + meta.ownerName : ""}!</p>
         <p>Recebemos a solicitação do seu campeonato. Guarde o código abaixo — ele identifica esse campeonato em todas as telas e comunicações.</p>
         <p><b>Código:</b> ${meta.codigo}<br>
         <b>Nome:</b> ${meta.nome}<br>
         <b>Início:</b> ${meta.dataInicio || "não informado"}<br>
         <b>Fim:</b> ${meta.dataFim || "não informado"}</p>
         <p>⏳ Ele está <b>aguardando aprovação</b> do admin do sistema. Você recebe um novo e-mail assim que a decisão for tomada.</p>`
      );
    }
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

async function torneiosAprovar(request: Request, env: Env): Promise<Response> {
  let body: any;
  try {
    body = await request.json();
  } catch {
    return json({ error: "JSON inválido" }, 400);
  }

  const solicitanteEmail = normEmail(body.adminEmail);
  if (!ehAdmin(solicitanteEmail)) {
    return json({ error: "Só o admin pode aprovar ou recusar torneios" }, 403);
  }

  const id = body.id;
  const decisao = ["aprovado", "recusado", "bloqueado"].includes(body.decisao) ? body.decisao : null;
  if (!id || !decisao) return json({ error: "id e decisao (aprovado|recusado|bloqueado) são obrigatórios" }, 400);

  const raw = await env.DB.get(`torneio:${id}`);
  if (!raw) return json({ error: "não encontrado" }, 404);
  const dados = JSON.parse(raw);

  dados.aprovacaoStatus = decisao;
  if (typeof body.dataInicio === "string") dados.dataInicio = body.dataInicio || null;
  if (typeof body.dataFim === "string") dados.dataFim = body.dataFim || null;
  dados.updatedAt = new Date().toISOString();

  const meta = {
    id: dados.id,
    codigo: dados.codigo,
    nome: dados.nome,
    status: dados.status,
    ownerEmail: dados.ownerEmail,
    ownerName: dados.ownerName,
    createdAt: dados.createdAt,
    updatedAt: dados.updatedAt,
    aprovacaoStatus: dados.aprovacaoStatus,
    dataInicio: dados.dataInicio,
    dataFim: dados.dataFim
  };

  try {
    await env.DB.put(`torneio:${id}`, JSON.stringify(dados));
    const index = await getIndex(env);
    const newIndex = index.filter((t: any) => t.id !== id);
    newIndex.push(meta);
    await env.DB.put("torneios:index", JSON.stringify(newIndex));
  } catch (e: any) {
    return json({ error: "Falha ao salvar", detail: String(e?.message || e) }, 500);
  }

  if (dados.ownerEmail) {
    const rotulos: Record<string, string> = {
      aprovado: "aprovado ✅",
      recusado: "recusado ❌",
      bloqueado: "bloqueado 🔒"
    };
    const corpos: Record<string, string> = {
      aprovado: `<p><b>Início:</b> ${dados.dataInicio || "não informado"}<br><b>Fim:</b> ${dados.dataFim || "não informado"}</p><p>Já está liberado para uso dentro desse período.</p>`,
      recusado: `<p>Se tiver dúvidas, entre em contato com o organizador do app.</p>`,
      bloqueado: `<p>Ele fica indisponível até ser liberado novamente pelo admin — as datas de validade (${dados.dataInicio || "não informado"} a ${dados.dataFim || "não informado"}) continuam guardadas e nada do que já foi feito se perde.</p>`
    };
    await enviarEmail(
      env,
      dados.ownerEmail,
      `Seu campeonato [${dados.codigo}] "${dados.nome}" foi ${rotulos[decisao]}`,
      `<p>Olá${dados.ownerName ? ", " + dados.ownerName : ""}!</p>
       <p>O campeonato <b>${dados.nome}</b> (código <b>${dados.codigo}</b>) foi <b>${rotulos[decisao]}</b>.</p>
       ${corpos[decisao]}`
    );
  }

  return json(meta);
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
   CONFIGURAÇÕES GLOBAIS DO APP (só o admin pode alterar)
============================================================ */
async function configGet(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const solicitanteEmail = normEmail(url.searchParams.get("email"));
  const googleClientId = (await env.DB.get("config:google_client_id")) || null;
  const resposta: any = { googleClientId };
  if (ehAdmin(solicitanteEmail)) {
    resposta.adminNotificationEmail = (await env.DB.get("config:admin_notification_email")) || null;
  }
  return json(resposta);
}

async function configSet(request: Request, env: Env): Promise<Response> {
  let body: any;
  try {
    body = await request.json();
  } catch {
    return json({ error: "JSON inválido" }, 400);
  }

  const solicitanteEmail = normEmail(body.email);
  if (!ehAdmin(solicitanteEmail)) {
    return json({ error: "Só o admin pode alterar as configurações do app" }, 403);
  }

  if (typeof body.googleClientId === "string") {
    await env.DB.put("config:google_client_id", body.googleClientId.trim());
  }
  if (typeof body.adminNotificationEmail === "string") {
    await env.DB.put("config:admin_notification_email", body.adminNotificationEmail.trim());
  }

  return json({ ok: true });
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
    if (path === "/api/torneios-aprovar") {
      return method === "POST" ? torneiosAprovar(request, env) : new Response("Method not allowed", { status: 405 });
    }
    if (path === "/api/config-get") {
      return configGet(request, env);
    }
    if (path === "/api/config-set") {
      return method === "POST" ? configSet(request, env) : new Response("Method not allowed", { status: 405 });
    }
    if (path.startsWith("/api/")) {
      return new Response("Not found", { status: 404 });
    }

    return env.ASSETS.fetch(request);
  }
};
