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
  // Lista de e-mails (Google, reais) com permissão de admin, separados por vírgula.
  // Ex: "fulano@gmail.com,ciclana@gmail.com". Configurado como secret no painel Cloudflare
  // (Settings → Variables and Secrets) — nunca pela tela do app.
  ADMIN_EMAILS?: string;
  // Credenciais do Mercado Pago (Suas integrações → credenciais de produção), como secrets.
  MP_ACCESS_TOKEN?: string;
  // Opcional, mas recomendado: chave secreta gerada ao configurar o Webhook no painel do
  // Mercado Pago (Suas integrações → Webhooks). Usada só pra filtrar notificações forjadas
  // mais cedo — o status do pagamento em si é sempre reconferido direto na API deles, então
  // o sistema continua seguro mesmo sem essa variável configurada.
  MP_WEBHOOK_SECRET?: string;
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
    // Import dinâmico (não no topo do arquivo): se "cloudflare:sockets" falhar por qualquer
    // motivo, isso afeta só o envio de e-mail — o resto do Worker (salvar torneio, placar de
    // TV, etc.) continua funcionando normalmente.
    const { connect } = await import("cloudflare:sockets");
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

// Admin agora é uma allowlist de e-mails Google reais (variável ADMIN_EMAILS no Worker),
// em vez de um e-mail fixo ligado à senha de teste "123456" (removida). Qualquer pessoa
// continua podendo logar com sua própria conta Google normalmente — só quem está nessa
// lista enxerga/edita torneios de outros donos e mexe nas configurações/aprovações do app.
function ehAdmin(email: string, env: Env): boolean {
  const lista = (env.ADMIN_EMAILS || "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return !!email && lista.includes(email);
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
  if (existing && normEmail(existing.ownerEmail) !== solicitanteEmail && !ehAdmin(solicitanteEmail, env)) {
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
    dataFim: existing ? existing.dataFim : (body.dataFim || null),
    pagamentoStatus: existing ? (existing.pagamentoStatus || "nao_solicitado") : "nao_solicitado",
    valorOverride: existing ? (existing.valorOverride ?? null) : null
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
  const meus = ehAdmin(solicitanteEmail, env)
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
  if (normEmail(dados.ownerEmail) !== solicitanteEmail && !ehAdmin(solicitanteEmail, env)) {
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
  if (!ehAdmin(solicitanteEmail, env)) {
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

  // Valor do Pix: o admin pode sobrescrever o cálculo automático (dias × R$ 70), por exemplo
  // pra aplicar desconto. Se vier 0, o campeonato é liberado direto, sem precisar de Pix.
  if (typeof body.valor === "number" && Number.isFinite(body.valor) && body.valor >= 0) {
    dados.valorOverride = body.valor;
    if (body.valor === 0) {
      dados.pagamento = {
        status: "isento",
        valor: 0,
        dias: calcularDias(dados.dataInicio, dados.dataFim),
        paymentId: null,
        copiaCola: null,
        qrCodeBase64: null,
        criadoEm: new Date().toISOString(),
        pagoEm: new Date().toISOString()
      };
    } else if (dados.pagamento?.status === "isento") {
      // Deixou de ser grátis depois de já ter sido marcado como isento — precisa gerar o Pix agora.
      dados.pagamento = null;
    }
  }

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
    dataFim: dados.dataFim,
    pagamentoStatus: dados.pagamento?.status || "nao_solicitado",
    valorOverride: dados.valorOverride ?? null
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
  if (existing && normEmail(existing.ownerEmail) !== solicitanteEmail && !ehAdmin(solicitanteEmail, env)) {
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
   PIX (Mercado Pago) — cobrança das diárias de uso
   Regra de valor: R$ 70,00 por diária, diária = cada dia dentro do período de validade
   (dataInicio..dataFim) que o próprio admin define ao aprovar o torneio. Só é possível gerar
   o Pix depois do torneio estar aprovado — os dados de validade precisam existir primeiro.
============================================================ */
const VALOR_DIARIA = 70;

function calcularDias(dataInicio?: string | null, dataFim?: string | null): number {
  if (!dataInicio || !dataFim) return 0;
  const ini = new Date(dataInicio + "T00:00:00Z").getTime();
  const fim = new Date(dataFim + "T00:00:00Z").getTime();
  if (Number.isNaN(ini) || Number.isNaN(fim) || fim < ini) return 0;
  return Math.round((fim - ini) / 86400000) + 1;
}

async function pixCriar(request: Request, env: Env): Promise<Response> {
  if (!env.MP_ACCESS_TOKEN) {
    return json({ error: "Pagamento via Pix não configurado neste servidor (MP_ACCESS_TOKEN ausente)" }, 500);
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return json({ error: "JSON inválido" }, 400);
  }

  const id = body.id;
  const solicitanteEmail = normEmail(body.email);
  if (!id) return json({ error: "id obrigatório" }, 400);
  if (!solicitanteEmail) return json({ error: "email obrigatório" }, 400);

  const raw = await env.DB.get(`torneio:${id}`);
  if (!raw) return json({ error: "não encontrado" }, 404);
  const dados = JSON.parse(raw);

  if (normEmail(dados.ownerEmail) !== solicitanteEmail && !ehAdmin(solicitanteEmail, env)) {
    return json({ error: "Sem permissão para gerar o Pix deste torneio" }, 403);
  }
  if (dados.aprovacaoStatus !== "aprovado") {
    return json({ error: "O torneio precisa estar aprovado antes de gerar o Pix" }, 400);
  }
  if (dados.pagamento?.status === "pago") {
    return json({ error: "Este torneio já está pago" }, 400);
  }

  const dias = calcularDias(dados.dataInicio, dados.dataFim);
  if (dias <= 0) {
    return json({ error: "Datas de início/fim inválidas para calcular o valor da diária" }, 400);
  }
  const valor = (typeof dados.valorOverride === "number" && dados.valorOverride >= 0)
    ? dados.valorOverride
    : dias * VALOR_DIARIA;
  if (valor <= 0) {
    return json({ error: "O valor está zerado — esse torneio já deveria ter sido liberado automaticamente na aprovação, sem precisar de Pix." }, 400);
  }

  const notificationUrl = `${new URL(request.url).origin}/api/pix-webhook`;

  let mpResp: any;
  try {
    const res = await fetch("https://api.mercadopago.com/v1/payments", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${env.MP_ACCESS_TOKEN}`,
        // Evita cobrar duas vezes se o app reenviar a mesma requisição (ex: conexão instável)
        "X-Idempotency-Key": `torneio-${id}-${dados.pagamento?.paymentId || "novo"}-${dias}-${valor}`
      },
      body: JSON.stringify({
        transaction_amount: valor,
        description: `Diárias de uso — campeonato ${dados.codigo} (${dias} diária${dias > 1 ? "s" : ""})`,
        payment_method_id: "pix",
        payer: { email: dados.ownerEmail || solicitanteEmail },
        external_reference: id,
        notification_url: notificationUrl
      })
    });
    mpResp = await res.json();
    if (!res.ok) return json({ error: "Falha ao criar cobrança no Mercado Pago", detail: mpResp }, 502);
  } catch (e: any) {
    return json({ error: "Falha de rede ao falar com o Mercado Pago", detail: String(e?.message || e) }, 502);
  }

  const txData = mpResp?.point_of_interaction?.transaction_data;
  if (!txData?.qr_code) {
    return json({ error: "Mercado Pago não retornou o código Pix", detail: mpResp }, 502);
  }

  dados.pagamento = {
    status: "pendente",
    valor,
    dias,
    paymentId: mpResp.id,
    copiaCola: txData.qr_code,
    qrCodeBase64: txData.qr_code_base64 || null,
    criadoEm: new Date().toISOString(),
    pagoEm: null
  };

  try {
    await env.DB.put(`torneio:${id}`, JSON.stringify(dados));
    const index = await getIndex(env);
    const idx = index.findIndex((t: any) => t.id === id);
    if (idx >= 0) {
      index[idx].pagamentoStatus = "pendente";
      await env.DB.put("torneios:index", JSON.stringify(index));
    }
  } catch (e: any) {
    return json({ error: "Falha ao salvar", detail: String(e?.message || e) }, 500);
  }

  return json({ ok: true, pagamento: dados.pagamento });
}

// Valida o header x-signature do Mercado Pago (formato "ts=...,v1=..."), conforme a
// documentação deles. Se MP_WEBHOOK_SECRET não estiver configurado, pula essa checagem —
// não é o único mecanismo de segurança: logo abaixo, o status do pagamento é sempre
// reconferido direto na API do Mercado Pago usando nosso próprio token, então uma notificação
// forjada não consegue, sozinha, liberar um torneio sem um pagamento aprovado de verdade.
async function verificarAssinaturaMP(request: Request, env: Env, dataId: string | null): Promise<boolean> {
  if (!env.MP_WEBHOOK_SECRET) return true;
  const xSignature = request.headers.get("x-signature");
  const xRequestId = request.headers.get("x-request-id");
  if (!xSignature) return false;

  let ts: string | null = null;
  let v1: string | null = null;
  for (const part of xSignature.split(",")) {
    const [k, v] = part.trim().split("=");
    if (k === "ts") ts = v;
    else if (k === "v1") v1 = v;
  }
  if (!ts || !v1) return false;

  const parts: string[] = [];
  if (dataId) parts.push(`id:${dataId.toLowerCase()}`);
  if (xRequestId) parts.push(`request-id:${xRequestId}`);
  parts.push(`ts:${ts}`);
  const manifest = parts.join(";") + ";";

  try {
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey("raw", enc.encode(env.MP_WEBHOOK_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const sig = await crypto.subtle.sign("HMAC", key, enc.encode(manifest));
    const hex = Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
    return hex === v1;
  } catch {
    return false;
  }
}

// Lógica compartilhada de "marcar como pago", usada tanto pelo webhook (automático) quanto
// pela verificação ativa (botão "Já paguei, verificar" — usada quando o webhook não chega).
// Idempotente: se já estava pago, não reenvia e-mail de novo.
async function confirmarPagamentoAprovado(env: Env, torneioId: string, pagamentoMP: any): Promise<any | null> {
  const raw = await env.DB.get(`torneio:${torneioId}`);
  if (!raw) return null;
  const dados = JSON.parse(raw);

  if (dados.pagamento?.status === "pago") return dados;

  dados.pagamento = { ...(dados.pagamento || {}), status: "pago", paymentId: pagamentoMP.id, pagoEm: new Date().toISOString() };
  dados.updatedAt = new Date().toISOString();

  try {
    await env.DB.put(`torneio:${torneioId}`, JSON.stringify(dados));
    const index = await getIndex(env);
    const idx = index.findIndex((t: any) => t.id === torneioId);
    if (idx >= 0) {
      index[idx].pagamentoStatus = "pago";
      await env.DB.put("torneios:index", JSON.stringify(index));
    }
  } catch {}

  if (dados.ownerEmail) {
    await enviarEmail(
      env,
      dados.ownerEmail,
      `Pagamento confirmado — campeonato [${dados.codigo}] "${dados.nome}"`,
      `<p>Olá${dados.ownerName ? ", " + dados.ownerName : ""}!</p>
       <p>Recebemos o pagamento das diárias do campeonato <b>${dados.nome}</b> (código <b>${dados.codigo}</b>). Ele já está liberado para uso.</p>`
    );
  }
  const adminEmail = await env.DB.get("config:admin_notification_email");
  if (adminEmail) {
    await enviarEmail(
      env,
      adminEmail,
      `💰 Pagamento recebido [${dados.codigo}]`,
      `<p>O campeonato <b>${dados.nome}</b> (código <b>${dados.codigo}</b>) teve o pagamento confirmado via Pix.</p>`
    );
  }

  return dados;
}

async function pixWebhook(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  let paymentId = url.searchParams.get("data.id") || url.searchParams.get("id");
  const tipo = url.searchParams.get("type") || url.searchParams.get("topic");

  let body: any = null;
  try {
    body = await request.json();
  } catch {}
  if (!paymentId && body?.data?.id) paymentId = String(body.data.id);

  // Só nos interessa notificação de pagamento — outros tópicos (merchant_order etc.) são ignorados.
  if (tipo && tipo !== "payment") return new Response("OK", { status: 200 });
  if (!paymentId) return new Response("OK", { status: 200 });

  const assinaturaOk = await verificarAssinaturaMP(request, env, paymentId);
  if (!assinaturaOk) return new Response("Assinatura inválida", { status: 401 });

  if (!env.MP_ACCESS_TOKEN) return new Response("OK", { status: 200 });

  // Fonte da verdade: consulta direta à API do Mercado Pago com nosso próprio token — nunca
  // confiamos apenas no conteúdo da notificação recebida, que poderia ser forjado.
  let pagamento: any;
  try {
    const res = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
      headers: { Authorization: `Bearer ${env.MP_ACCESS_TOKEN}` }
    });
    if (!res.ok) return new Response("OK", { status: 200 });
    pagamento = await res.json();
  } catch {
    return new Response("OK", { status: 200 });
  }

  const torneioId = pagamento?.external_reference;
  if (!torneioId || pagamento?.status !== "approved") return new Response("OK", { status: 200 });

  await confirmarPagamentoAprovado(env, torneioId, pagamento);

  return new Response("OK", { status: 200 });
}

// Verificação ATIVA (sob demanda): usada pelo botão "Já paguei, verificar" no app. Não depende
// do webhook ter chegado — consulta a API do Mercado Pago na hora, usando o paymentId que
// guardamos ao gerar o Pix. Isso cobre os casos em que o webhook falha, atrasa, ou nem chega
// (assinatura errada, URL de notificação desatualizada, instabilidade, etc.).
async function pixVerificar(request: Request, env: Env): Promise<Response> {
  if (!env.MP_ACCESS_TOKEN) {
    return json({ error: "Pagamento via Pix não configurado neste servidor (MP_ACCESS_TOKEN ausente)" }, 500);
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return json({ error: "JSON inválido" }, 400);
  }

  const id = body.id;
  const solicitanteEmail = normEmail(body.email);
  if (!id) return json({ error: "id obrigatório" }, 400);
  if (!solicitanteEmail) return json({ error: "email obrigatório" }, 400);

  const raw = await env.DB.get(`torneio:${id}`);
  if (!raw) return json({ error: "não encontrado" }, 404);
  const dados = JSON.parse(raw);

  if (normEmail(dados.ownerEmail) !== solicitanteEmail && !ehAdmin(solicitanteEmail, env)) {
    return json({ error: "Sem permissão para verificar o pagamento deste torneio" }, 403);
  }

  if (dados.pagamento?.status === "pago" || dados.pagamento?.status === "isento") {
    return json({ ok: true, pagamento: dados.pagamento });
  }

  const paymentId = dados.pagamento?.paymentId;
  if (!paymentId) return json({ ok: true, pagamento: dados.pagamento || null });

  try {
    const res = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
      headers: { Authorization: `Bearer ${env.MP_ACCESS_TOKEN}` }
    });
    if (!res.ok) return json({ ok: true, pagamento: dados.pagamento, statusMercadoPago: null });
    const pagamentoMP = await res.json();

    if (pagamentoMP?.status === "approved") {
      const atualizado = await confirmarPagamentoAprovado(env, id, pagamentoMP);
      return json({ ok: true, pagamento: atualizado?.pagamento || dados.pagamento });
    }
    return json({ ok: true, pagamento: dados.pagamento, statusMercadoPago: pagamentoMP?.status || null });
  } catch (e: any) {
    return json({ error: "Falha de rede ao falar com o Mercado Pago", detail: String(e?.message || e) }, 502);
  }
}

/* ============================================================
   CONFIGURAÇÕES GLOBAIS DO APP (só o admin pode alterar)
============================================================ */
async function configGet(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const solicitanteEmail = normEmail(url.searchParams.get("email"));
  const googleClientId = (await env.DB.get("config:google_client_id")) || null;
  const isAdmin = solicitanteEmail ? ehAdmin(solicitanteEmail, env) : false;
  const resposta: any = { googleClientId, isAdmin };
  if (isAdmin) {
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
  if (!ehAdmin(solicitanteEmail, env)) {
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
    if (path === "/api/pix-criar") {
      return method === "POST" ? pixCriar(request, env) : new Response("Method not allowed", { status: 405 });
    }
    if (path === "/api/pix-webhook") {
      return pixWebhook(request, env);
    }
    if (path === "/api/pix-verificar") {
      return method === "POST" ? pixVerificar(request, env) : new Response("Method not allowed", { status: 405 });
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
