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

// Mesma regra de expiração do front-end (torneioEstaAtivo, motivo "depois"), só que aqui serve
// de segunda trava: mesmo que alguém contorne a UI somente-leitura, o servidor recusa qualquer
// escrita de dado de um torneio já expirado (exceto pelo admin do app).
function torneioExpirado(dataFim: string | null | undefined): boolean {
  if (!dataFim) return false;
  const hojeISO = new Date().toISOString().slice(0, 10);
  return hojeISO > dataFim;
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

  // O índice só guarda um resumo leve — pra não perder campos que não fazem parte dele (como o
  // objeto completo do pagamento Pix: código copia-e-cola, QR, paymentId, etc.), buscamos aqui
  // o registro completo já salvo e preservamos esse campo ao regravar o torneio.
  const existingRaw = existing ? await env.DB.get(`torneio:${id}`) : null;
  const existingFull = existingRaw ? JSON.parse(existingRaw) : null;

  // Só o dono original (ou o admin) pode atualizar um torneio já existente.
  if (existing && normEmail(existing.ownerEmail) !== solicitanteEmail && !ehAdmin(solicitanteEmail, env)) {
    return json({ error: "Sem permissão para alterar este torneio" }, 403);
  }

  // Torneio expirado: só leitura pra todo mundo, exceto o admin do app (que pode reabrir
  // ajustando as datas pela tela de Aprovações).
  if (existing && torneioExpirado(existing.dataFim) && !ehAdmin(solicitanteEmail, env)) {
    return json({ error: "Este campeonato está encerrado — somente leitura, não é possível salvar alterações." }, 403);
  }

  // Cupom de desconto: só é considerado na CRIAÇÃO (nunca muda depois, mesmo re-salvando o
  // torneio) — revalidado aqui no servidor (nunca confia na checagem "ao vivo" do cliente) e,
  // se válido, incrementa o contador de usos do cupom nesse mesmo passo.
  let cupomAplicado = existing ? (existing.cupomAplicado ?? null) : null;
  if (ehNovo && body.cupomNome) {
    const { lista: listaCupons, cupom, valido } = await resolverCupom(env, body.cupomNome);
    if (cupom && valido) {
      cupomAplicado = { nome: cupom.nome, percentual: cupom.percentual };
      cupom.usos = (cupom.usos || 0) + 1;
      cupom.updatedAt = new Date().toISOString();
      await saveCuponsIndex(env, listaCupons);
    }
  }

  const meta = {
    id,
    codigo: existing ? existing.codigo : await gerarCodigoTorneio(env),
    // Preserva o nome já salvo se o payload chegar sem nome (torneio existente) — sem isso, um
    // client com o state corrompido/zerado (ver enviarTorneioAgora no front, bug do "Trocar
    // torneio" enquanto uma sincronização ainda estava em voo) sobrescrevia o nome de um torneio
    // real por "Torneio sem nome" a cada resync. Só cai no genérico mesmo na criação (existing
    // nulo) quando o organizador realmente não informou nome nenhum.
    nome: body.nome || existing?.nome || "Torneio sem nome",
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
    valorOverride: existing ? (existing.valorOverride ?? null) : null,
    cupomAplicado,
    // Controle manual do admin (relatório de uso de cupons: "repassei a comissão desse uso pro
    // parceiro?") — nada a ver com o jogo em si, então preserva como os outros campos de
    // identidade/financeiro: nunca reseta sozinho num re-salvamento normal do torneio.
    comissaoRepassada: existing ? !!existing.comissaoRepassada : false,
    comissaoRepassadaEm: existing ? (existing.comissaoRepassadaEm ?? null) : null
  };

  // O cliente que está salvando pode estar com uma cópia desatualizada da arbitragem — por
  // exemplo, se um árbitro convidado (link de "Apitar jogo") gerou um token ou pontuou uma
  // partida depois da última vez que este cliente carregou o torneio. Sem isso, o próximo
  // salvamento normal (qualquer coisa que o organizador editar) sobrescreveria e perderia
  // esse progresso, ou pior, invalidaria o link (token apagado) mesmo sem ninguém mexer nele.
  const STATUS_RANK: Record<string, number> = { nao_iniciada: 0, andamento: 1, tecnico: 1, finalizada: 2 };
  if (existingFull?.state?.arbitragem && body.state) {
    if (!body.state.arbitragem) body.state.arbitragem = {};
    for (const matchId of Object.keys(existingFull.state.arbitragem)) {
      const arbServidor: any = existingFull.state.arbitragem[matchId];
      const arbCliente: any = body.state.arbitragem[matchId];
      if (!arbServidor) continue;

      if (!arbCliente) {
        body.state.arbitragem[matchId] = arbServidor;
        const ref = getMatchRef(body.state, matchId);
        // Nunca REGRIDE finalizado pra false aqui — só avança pra true quando a arbitragem
        // realmente diz "finalizada". Um jogo pode estar finalizado por outro caminho (placar
        // digitado direto) sem que a arbitragem desse cliente saiba disso; sobrescrever com
        // false reabriria um jogo que já tinha um resultado válido.
        if (ref) {
          ref.pa = arbServidor.placarA;
          ref.pb = arbServidor.placarB;
          if (arbServidor.status === "finalizada") ref.finalizado = true;
        }
        continue;
      }

      // Preserva sempre o token do link de árbitro convidado, mesmo que o cliente não o conheça.
      if (arbServidor.tokenApito && !arbCliente.tokenApito) arbCliente.tokenApito = arbServidor.tokenApito;

      // Prioridade 1: quem tem o "atualizadoEm" mais recente é quem realmente sabe o estado
      // mais novo — isso é o que permite reabrir uma partida de verdade. Antes disso, o merge só
      // olhava pra "rank" do status (nao_iniciada < andamento/tecnico < finalizada), então um
      // reabrir (que baixa o rank) sempre perdia pro "finalizada" antigo salvo no servidor: o
      // jogo reabria na tela por um instante e voltava sozinho pra "concluído" assim que o
      // próximo refresh buscava de novo o estado (revertido) salvo no KV.
      // Prioridade 2 (fallback): só usada em dados antigos sem esse campo, ou empate exato —
      // mantém o comportamento conservador de nunca regredir "finalizado" pra false, já que aí
      // não dá pra saber com certeza qual lado é realmente mais novo.
      const atualizadoServidor = arbServidor.atualizadoEm || 0;
      const atualizadoCliente = arbCliente.atualizadoEm || 0;
      let servidorVence: boolean;
      let comparacaoConfiavel: boolean;
      if (atualizadoServidor !== atualizadoCliente) {
        servidorVence = atualizadoServidor > atualizadoCliente;
        comparacaoConfiavel = true;
      } else {
        const rankServidor = STATUS_RANK[arbServidor.status] ?? 0;
        const rankCliente = STATUS_RANK[arbCliente.status] ?? 0;
        const somaServidor = (arbServidor.placarA || 0) + (arbServidor.placarB || 0);
        const somaCliente = (arbCliente.placarA || 0) + (arbCliente.placarB || 0);
        servidorVence = rankServidor > rankCliente || (rankServidor === rankCliente && somaServidor > somaCliente);
        comparacaoConfiavel = false;
      }

      if (servidorVence) {
        body.state.arbitragem[matchId] = { ...arbServidor, tokenApito: arbServidor.tokenApito || arbCliente.tokenApito };
        const ref = getMatchRef(body.state, matchId);
        if (ref) {
          ref.pa = arbServidor.placarA;
          ref.pb = arbServidor.placarB;
          if (comparacaoConfiavel) {
            // Comparação por timestamp é confiável — pode regredir "finalizado" pra false
            // também (ex: reabertura que chegou ao servidor por outro caminho).
            ref.finalizado = arbServidor.status === "finalizada";
          } else if (arbServidor.status === "finalizada") {
            ref.finalizado = true;
          }
        }
      }
    }
  }

  // Detecta eventos relevantes pro log de atividade comparando o estado antes/depois — cobre
  // qualquer caminho que leve a essas mudanças (apitar, digitar placar direto, W.O.) sem precisar
  // duplicar um hook em cada um. Só grava de fato depois que o save principal confirmar sucesso.
  const logsParaRegistrar: Array<Omit<LogEntry, "id" | "quando">> = [];
  if (ehNovo) {
    logsParaRegistrar.push({
      tipo: "torneio_criado",
      atorEmail: solicitanteEmail,
      atorNome: body.ownerName || null,
      torneioId: id,
      torneioNome: meta.nome,
      torneioCodigo: meta.codigo,
      descricao: `Torneio "${meta.nome}" criado`,
      dados: { dataInicio: meta.dataInicio, dataFim: meta.dataFim, cupomAplicado }
    });
  }
  if (!existingFull?.state?.drawn && body.state?.drawn) {
    const duplas = (body.state.duplas || []).map((d: any) => d?.nome).filter(Boolean);
    logsParaRegistrar.push({
      tipo: "duplas_sorteadas",
      atorEmail: solicitanteEmail,
      atorNome: body.ownerName || null,
      torneioId: id,
      torneioNome: meta.nome,
      torneioCodigo: meta.codigo,
      descricao: `Sorteio realizado (${duplas.length} duplas, formato ${body.state.formato === "eliminacao" ? "eliminação" : "grupos"})`,
      dados: { formato: body.state.formato, duplas }
    });
  }
  {
    const matchesAntesMap = new Map(listarTodosMatches(existingFull?.state).map((x) => [x.matchId, x.m]));
    for (const { matchId, m } of listarTodosMatches(body.state)) {
      const antes = matchesAntesMap.get(matchId);
      if (m?.finalizado && !antes?.finalizado) {
        logsParaRegistrar.push({
          tipo: "resultado_registrado",
          atorEmail: solicitanteEmail,
          atorNome: body.ownerName || null,
          torneioId: id,
          torneioNome: meta.nome,
          torneioCodigo: meta.codigo,
          descricao: `Jogo finalizado: ${m.a || "?"} ${m.pa ?? "-"} x ${m.pb ?? "-"} ${m.b || "?"}${m.wo ? " (W.O.)" : ""}`,
          dados: { matchId, a: m.a, b: m.b, pa: m.pa, pb: m.pb, wo: m.wo || null }
        });
      }
    }
  }

  try {
    await env.DB.put(`torneio:${id}`, JSON.stringify({ ...meta, pagamento: existingFull?.pagamento ?? null, state: body.state }));
    const newIndex = index.filter((t: any) => t.id !== id);
    newIndex.push(meta);
    await env.DB.put("torneios:index", JSON.stringify(newIndex));
  } catch (e: any) {
    return json({ error: "Falha ao salvar", detail: String(e?.message || e) }, 500);
  }
  await registrarLogs(env, logsParaRegistrar);

  // Pix automático na criação: as datas e o cupom já foram escolhidos pelo organizador no
  // formulário, então o valor já está totalmente determinado — não precisa mais esperar a
  // aprovação do admin (que agora é só uma revisão em paralelo). Se o desconto zerar o valor
  // (ex: cupom de 100%), libera direto como isento em vez de tentar gerar um Pix de R$ 0.
  let pagamentoResultante: any = existingFull?.pagamento ?? null;
  const diasNovo = calcularDias(meta.dataInicio, meta.dataFim);
  const valorDiariaNovo = await getValorDiaria(env);
  const valorEstim = calcularValorComCupom(diasNovo, cupomAplicado, valorDiariaNovo);
  if (ehNovo && diasNovo > 0) {
    if (valorEstim <= 0) {
      // Cupom de 100% (ou outro caso de valor zerado) equivale a um pagamento já resolvido —
      // libera na hora, sem precisar de uma aprovação manual separada do admin.
      pagamentoResultante = {
        status: "isento", valor: 0, dias: diasNovo, paymentId: null, copiaCola: null, qrCodeBase64: null,
        criadoEm: new Date().toISOString(), pagoEm: new Date().toISOString()
      };
      meta.aprovacaoStatus = "aprovado";
      try {
        const rawAtual = await env.DB.get(`torneio:${id}`);
        if (rawAtual) {
          const dadosAtual = JSON.parse(rawAtual);
          dadosAtual.pagamento = pagamentoResultante;
          dadosAtual.aprovacaoStatus = "aprovado";
          await env.DB.put(`torneio:${id}`, JSON.stringify(dadosAtual));
          const idxAtual = await getIndex(env);
          const pos = idxAtual.findIndex((t: any) => t.id === id);
          if (pos >= 0) {
            idxAtual[pos].pagamentoStatus = "isento";
            idxAtual[pos].aprovacaoStatus = "aprovado";
            await env.DB.put("torneios:index", JSON.stringify(idxAtual));
          }
        }
      } catch {}
    } else {
      const resultadoPix = await gerarCobrancaPix(env, id, new URL(request.url).origin, solicitanteEmail);
      if (resultadoPix.ok) {
        pagamentoResultante = resultadoPix.pagamento;
        meta.aprovacaoStatus = resultadoPix.aprovacaoStatus || meta.aprovacaoStatus;
      }
    }
    meta.pagamentoStatus = pagamentoResultante?.status || meta.pagamentoStatus;
  }

  if (ehNovo) {
    const adminEmail = await env.DB.get("config:admin_notification_email");
    if (adminEmail) {
      await enviarEmail(
        env,
        adminEmail,
        `Novo campeonato solicitado [${meta.codigo}]: ${meta.nome}`,
        `<p>Um novo campeonato foi criado${pagamentoResultante?.status === "pendente" ? " e o Pix já foi gerado automaticamente" : ""}.</p>
         <p><b>Código:</b> ${meta.codigo}<br>
         <b>Nome:</b> ${meta.nome}<br>
         <b>Organizador:</b> ${meta.ownerName || "-"} (${meta.ownerEmail || "-"})<br>
         <b>Início:</b> ${meta.dataInicio || "não informado"}<br>
         <b>Fim:</b> ${meta.dataFim || "não informado"}<br>
         <b>Valor estimado:</b> ${diasNovo ? `R$ ${valorEstim.toFixed(2).replace(".", ",")} (${diasNovo} diária${diasNovo > 1 ? "s" : ""} × R$ ${valorDiariaNovo.toFixed(2).replace(".", ",")}${cupomAplicado ? `, cupom ${cupomAplicado.nome} -${cupomAplicado.percentual}%` : ""})` : "não foi possível calcular"}</p>
         <p>Entre no app com a conta admin, aba Aprovações, pra revisar (o valor pode ser ajustado por lá).</p>`
      );
    }
    if (meta.ownerEmail) {
      const corpoPagamento = pagamentoResultante?.status === "isento"
        ? `<p>Esse campeonato foi liberado automaticamente, sem custo.</p>`
        : pagamentoResultante?.copiaCola
          ? `<p><b>Valor das diárias:</b> R$ ${valorEstim.toFixed(2).replace(".", ",")}${diasNovo ? ` (${diasNovo} diária${diasNovo > 1 ? "s" : ""})` : ""}</p>
             <p>Pague via Pix usando o código copia-e-cola abaixo (ou escaneie o QR direto no app) para liberar o uso:</p>
             <p style="word-break:break-all;font-family:monospace;background:#f4f4f4;padding:8px;border-radius:6px;">${pagamentoResultante.copiaCola}</p>
             <p>Assim que o pagamento for identificado, o campeonato é liberado automaticamente — a aprovação do admin acontece em paralelo, sem afetar o pagamento.</p>`
          : `<p>⏳ Ainda não foi possível gerar o Pix automaticamente — abra o app pra gerar o código manualmente. Você também recebe um novo e-mail assim que o admin revisar a solicitação.</p>`;
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
         ${corpoPagamento}`
      );
    }
  }

  return json({ ...meta, pagamento: pagamentoResultante });
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

// Marca (ou desmarca) a comissão de um uso de cupom como já repassada — só um controle manual do
// admin pro relatório de uso de cupons, não mexe em pagamento nem em jogo nenhum. Atualização
// cirúrgica (registro completo + campo correspondente no índice), igual pixCriar/
// confirmarPagamentoAprovado, pra não correr o risco de reconstruir o meta inteiro e derrubar
// outro campo por engano (foi exatamente isso que já aconteceu com cupomAplicado antes).
async function torneiosComissao(request: Request, env: Env): Promise<Response> {
  let body: any;
  try {
    body = await request.json();
  } catch {
    return json({ error: "JSON inválido" }, 400);
  }
  const solicitanteEmail = normEmail(body.email);
  if (!ehAdmin(solicitanteEmail, env)) return json({ error: "Só o admin pode controlar o repasse de comissão" }, 403);

  const id = body.id;
  if (!id) return json({ error: "id obrigatório" }, 400);
  const repassada = !!body.repassada;

  const raw = await env.DB.get(`torneio:${id}`);
  if (!raw) return json({ error: "não encontrado" }, 404);
  const dados = JSON.parse(raw);
  if (!dados.cupomAplicado) return json({ error: "Este torneio não usou cupom" }, 400);

  dados.comissaoRepassada = repassada;
  dados.comissaoRepassadaEm = repassada ? new Date().toISOString() : null;

  try {
    await env.DB.put(`torneio:${id}`, JSON.stringify(dados));
    const index = await getIndex(env);
    const idx = index.findIndex((t: any) => t.id === id);
    if (idx >= 0) {
      index[idx].comissaoRepassada = dados.comissaoRepassada;
      index[idx].comissaoRepassadaEm = dados.comissaoRepassadaEm;
      await env.DB.put("torneios:index", JSON.stringify(index));
    }
  } catch (e: any) {
    return json({ error: "Falha ao salvar", detail: String(e?.message || e) }, 500);
  }

  return json({ ok: true, comissaoRepassada: dados.comissaoRepassada, comissaoRepassadaEm: dados.comissaoRepassadaEm });
}

/* ============================================================
   CUPONS DE DESCONTO
   Guardados numa única chave (cupons:index, lista completa) — ao contrário dos torneios,
   não existe um "detalhe pesado" separado por cupom, então não precisa do par índice+registro.
   O nome do cupom é o próprio índice (nunca pode repetir), comparado sempre sem diferenciar
   maiúsculas/minúsculas via nomeNormalizado.
============================================================ */
interface Cupom {
  nome: string; // como foi cadastrado (exibição)
  nomeNormalizado: string; // MAIÚSCULO, usado pra comparar/achar duplicidade
  percentual: number; // 0-100, desconto dado ao cliente que usa o cupom
  dataInicio: string | null;
  dataFim: string | null;
  status: "ativo" | "bloqueado";
  maxUsos: number | null; // null = ilimitado
  usos: number;
  // % de comissão a repassar pra quem indicou/divulgou o cupom (ex: parceiro, influenciador) —
  // independente do desconto dado ao cliente (percentual acima). null = comissão não configurada.
  // Sempre lido "ao vivo" do cadastro atual do cupom no relatório de uso (nunca travado no
  // momento do uso, diferente do desconto — pode ser ajustado depois sem afetar torneios já
  // concluídos financeiramente, já que o acordo de comissão é externo ao app).
  comissaoPercentual: number | null;
  createdAt: string;
  updatedAt: string;
}

async function getCuponsIndex(env: Env): Promise<Cupom[]> {
  try {
    const raw = await env.DB.get("cupons:index");
    if (raw) return JSON.parse(raw);
  } catch {}
  return [];
}
async function saveCuponsIndex(env: Env, lista: Cupom[]): Promise<void> {
  await env.DB.put("cupons:index", JSON.stringify(lista));
}
function normalizarNomeCupom(nome: unknown): string {
  return String(nome || "").trim().toUpperCase();
}
function hojeISOUTC(): string {
  return new Date().toISOString().slice(0, 10);
}
// Só checa status/validade/limite de usos de um cupom já encontrado — não mexe em contador nenhum.
function checarValidadeCupom(cupom: Cupom, hojeISO: string): { valido: boolean; motivo: string | null } {
  if (cupom.status === "bloqueado") return { valido: false, motivo: "Este cupom foi bloqueado." };
  if (cupom.dataInicio && hojeISO < cupom.dataInicio) return { valido: false, motivo: "Este cupom ainda não começou a valer." };
  if (cupom.dataFim && hojeISO > cupom.dataFim) return { valido: false, motivo: "Este cupom já expirou." };
  if (typeof cupom.maxUsos === "number" && cupom.usos >= cupom.maxUsos) return { valido: false, motivo: "Este cupom já atingiu o limite de usos." };
  return { valido: true, motivo: null };
}
// Usado tanto pela checagem "ao vivo" (tela de criação de torneio) quanto pelo fechamento real
// da criação (torneiosSave) — devolve a lista inteira já carregada, pra quem for gravar um uso
// não precisar buscar a chave de novo (cupom é uma referência ao item dentro dessa mesma lista).
async function resolverCupom(env: Env, nomeDigitado: unknown): Promise<{ lista: Cupom[]; cupom: Cupom | null; valido: boolean; motivo: string | null }> {
  const nomeNormalizado = normalizarNomeCupom(nomeDigitado);
  const lista = await getCuponsIndex(env);
  if (!nomeNormalizado) return { lista, cupom: null, valido: false, motivo: "Informe o nome do cupom." };
  const cupom = lista.find((c) => c.nomeNormalizado === nomeNormalizado) || null;
  if (!cupom) return { lista, cupom: null, valido: false, motivo: "Cupom não encontrado." };
  const { valido, motivo } = checarValidadeCupom(cupom, hojeISOUTC());
  return { lista, cupom, valido, motivo };
}

async function cuponsList(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const solicitanteEmail = normEmail(url.searchParams.get("email"));
  if (!ehAdmin(solicitanteEmail, env)) return json({ error: "Só o admin pode ver os cupons" }, 403);
  return json({ cupons: await getCuponsIndex(env) });
}

async function cuponsSalvar(request: Request, env: Env): Promise<Response> {
  let body: any;
  try {
    body = await request.json();
  } catch {
    return json({ error: "JSON inválido" }, 400);
  }
  const solicitanteEmail = normEmail(body.email);
  if (!ehAdmin(solicitanteEmail, env)) return json({ error: "Só o admin pode cadastrar cupons" }, 403);

  const nome = String(body.nome || "").trim();
  if (!nome) return json({ error: "Nome do cupom obrigatório" }, 400);
  const nomeNormalizado = normalizarNomeCupom(nome);

  const percentual = Number(body.percentual);
  if (!Number.isFinite(percentual) || percentual <= 0 || percentual > 100) {
    return json({ error: "Percentual precisa ser maior que 0 e no máximo 100" }, 400);
  }

  const dataInicio = body.dataInicio || null;
  const dataFim = body.dataFim || null;
  if (!dataInicio || !dataFim) return json({ error: "Informe as datas de início e fim da validade" }, 400);
  if (dataFim < dataInicio) return json({ error: "A data de fim não pode ser antes da data de início" }, 400);

  let maxUsos: number | null = null;
  if (body.maxUsos !== null && body.maxUsos !== undefined && body.maxUsos !== "") {
    const n = Number(body.maxUsos);
    if (!Number.isFinite(n) || n < 1) {
      return json({ error: "Máximo de usos precisa ser um número maior que 0, ou deixe em branco pra ilimitado" }, 400);
    }
    maxUsos = Math.floor(n);
  }

  const lista = await getCuponsIndex(env);
  if (lista.some((c) => c.nomeNormalizado === nomeNormalizado)) {
    return json({ error: `Já existe um cupom "${nome}" — os nomes não podem se repetir.` }, 400);
  }

  const comissaoPercentual = parseComissaoPercentual(body.comissaoPercentual);
  if (comissaoPercentual === false) {
    return json({ error: "Percentual de comissão precisa ser entre 0 e 100, ou deixe em branco" }, 400);
  }

  const now = new Date().toISOString();
  const novo: Cupom = { nome, nomeNormalizado, percentual, dataInicio, dataFim, status: "ativo", maxUsos, usos: 0, comissaoPercentual, createdAt: now, updatedAt: now };
  lista.push(novo);
  await saveCuponsIndex(env, lista);
  return json({ ok: true, cupom: novo });
}

// Devolve `false` (valor que nunca é um percentual válido) pra sinalizar entrada inválida sem
// misturar com `null`, que aqui é um valor legítimo (comissão não configurada).
function parseComissaoPercentual(v: unknown): number | null | false {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 100) return false;
  return n;
}

async function cuponsRemover(request: Request, env: Env): Promise<Response> {
  let body: any;
  try {
    body = await request.json();
  } catch {
    return json({ error: "JSON inválido" }, 400);
  }
  const solicitanteEmail = normEmail(body.email);
  if (!ehAdmin(solicitanteEmail, env)) return json({ error: "Só o admin pode remover cupons" }, 403);

  const nomeNormalizado = normalizarNomeCupom(body.nome);
  const lista = await getCuponsIndex(env);
  const nova = lista.filter((c) => c.nomeNormalizado !== nomeNormalizado);
  if (nova.length === lista.length) return json({ error: "Cupom não encontrado" }, 404);
  await saveCuponsIndex(env, nova);
  return json({ ok: true });
}

async function cuponsBloquear(request: Request, env: Env): Promise<Response> {
  let body: any;
  try {
    body = await request.json();
  } catch {
    return json({ error: "JSON inválido" }, 400);
  }
  const solicitanteEmail = normEmail(body.email);
  if (!ehAdmin(solicitanteEmail, env)) return json({ error: "Só o admin pode bloquear/desbloquear cupons" }, 403);

  const nomeNormalizado = normalizarNomeCupom(body.nome);
  const lista = await getCuponsIndex(env);
  const cupom = lista.find((c) => c.nomeNormalizado === nomeNormalizado);
  if (!cupom) return json({ error: "Cupom não encontrado" }, 404);
  cupom.status = body.bloquear ? "bloqueado" : "ativo";
  cupom.updatedAt = new Date().toISOString();
  await saveCuponsIndex(env, lista);
  return json({ ok: true, cupom });
}

// Só mexe na % de comissão (repasse pra quem indicou o cupom) — separado de cuponsSalvar porque
// esse dado pode ser configurado/ajustado bem depois do cupom já existir e já ter sido usado,
// ao contrário do desconto (percentual), que é travado por torneio no momento do uso.
async function cuponsEditarComissao(request: Request, env: Env): Promise<Response> {
  let body: any;
  try {
    body = await request.json();
  } catch {
    return json({ error: "JSON inválido" }, 400);
  }
  const solicitanteEmail = normEmail(body.email);
  if (!ehAdmin(solicitanteEmail, env)) return json({ error: "Só o admin pode configurar a comissão dos cupons" }, 403);

  const comissaoPercentual = parseComissaoPercentual(body.comissaoPercentual);
  if (comissaoPercentual === false) {
    return json({ error: "Percentual de comissão precisa ser entre 0 e 100, ou deixe em branco pra remover" }, 400);
  }

  const nomeNormalizado = normalizarNomeCupom(body.nome);
  const lista = await getCuponsIndex(env);
  const cupom = lista.find((c) => c.nomeNormalizado === nomeNormalizado);
  if (!cupom) return json({ error: "Cupom não encontrado" }, 404);
  cupom.comissaoPercentual = comissaoPercentual;
  cupom.updatedAt = new Date().toISOString();
  await saveCuponsIndex(env, lista);
  return json({ ok: true, cupom });
}

// Público (só precisa de e-mail logado, não precisa ser admin) — validação "ao vivo" enquanto o
// organizador digita o cupom na tela de criação do torneio. Não incrementa uso nenhum; isso só
// acontece de verdade dentro de torneiosSave, no fechamento real da criação.
async function cuponsValidar(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const { cupom, valido, motivo } = await resolverCupom(env, url.searchParams.get("nome"));
  if (!valido) return json({ valido: false, motivo });
  return json({ valido: true, percentual: cupom!.percentual, motivo: null });
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

  const valorDiariaAtual = await getValorDiaria(env);

  // Valor do Pix: o admin pode sobrescrever o cálculo automático (dias × valor da diária), por
  // exemplo pra aplicar desconto. Se vier 0, o campeonato é liberado direto, sem precisar de Pix.
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

  // Se o valor definido pelo admin não bate com o que o cupom aplicado geraria automaticamente,
  // ele está efetivamente sobrescrevendo/ignorando o desconto — nesse caso, esse uso não deveria
  // contar pro limite do cupom. cupomUsoRevertido evita reverter de novo numa aprovação seguinte
  // deste mesmo torneio (só acontece uma vez).
  if (typeof body.valor === "number" && dados.cupomAplicado && !dados.cupomUsoRevertido) {
    const diasParaCupom = calcularDias(dados.dataInicio, dados.dataFim);
    const valorEsperadoComCupom = calcularValorComCupom(diasParaCupom, dados.cupomAplicado, valorDiariaAtual);
    const bateComEsperado = Math.round(body.valor * 100) === Math.round(valorEsperadoComCupom * 100);
    if (!bateComEsperado) {
      const listaCupons = await getCuponsIndex(env);
      const cupomIdx = listaCupons.findIndex((c) => c.nomeNormalizado === normalizarNomeCupom(dados.cupomAplicado.nome));
      if (cupomIdx >= 0) {
        listaCupons[cupomIdx].usos = Math.max(0, (listaCupons[cupomIdx].usos || 0) - 1);
        listaCupons[cupomIdx].updatedAt = new Date().toISOString();
        await saveCuponsIndex(env, listaCupons);
      }
      dados.cupomUsoRevertido = true;
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
    valorOverride: dados.valorOverride ?? null,
    // Sem isso aqui, o índice (torneios:index) perdia o cupomAplicado desse torneio pra sempre
    // assim que o admin aprovasse/recusasse/bloqueasse — a lista de Aprovações e o relatório de
    // uso de cupons (que leem do índice, não do registro completo) passavam a não mostrar mais o
    // cupom usado, mesmo ele continuando salvo no registro completo (dados.cupomAplicado).
    cupomAplicado: dados.cupomAplicado ?? null,
    comissaoRepassada: !!dados.comissaoRepassada,
    comissaoRepassadaEm: dados.comissaoRepassadaEm ?? null
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

  // Pix automático: assim que o torneio é aprovado com um valor a cobrar, já gera a cobrança na
  // hora, sem esperar o organizador abrir o app e clicar em "Gerar Pix". Reaproveita a mesma
  // função da rota manual (gerarCobrancaPix), que faz sua própria leitura/gravação no KV — por
  // isso lê e grava de novo aqui em cima do que acabou de ser salvo, em vez de tentar economizar
  // numa escrita só. Se falhar (Mercado Pago fora do ar, token ausente etc.), não derruba a
  // aprovação: o organizador ainda consegue gerar manualmente pelo app, como antes.
  if (decisao === "aprovado" && dados.pagamento?.status !== "pago" && dados.pagamento?.status !== "isento") {
    const resultadoPix = await gerarCobrancaPix(env, id, new URL(request.url).origin);
    if (resultadoPix.ok) {
      dados.pagamento = resultadoPix.pagamento;
      dados.aprovacaoStatus = resultadoPix.aprovacaoStatus || dados.aprovacaoStatus;
      meta.pagamentoStatus = dados.pagamento?.status || meta.pagamentoStatus;
      meta.aprovacaoStatus = dados.aprovacaoStatus;
    }
  }

  if (dados.ownerEmail) {
    const diasCalc = calcularDias(dados.dataInicio, dados.dataFim);
    const valorEfetivo = typeof dados.valorOverride === "number" ? dados.valorOverride : calcularValorComCupom(diasCalc, dados.cupomAplicado, valorDiariaAtual);
    const rotulos: Record<string, string> = {
      aprovado: "aprovado ✅",
      recusado: "recusado ❌",
      bloqueado: "bloqueado 🔒"
    };
    // Se o pagamento já estiver confirmado (ex: o organizador pagou entre a criação e essa
    // aprovação), não faz sentido reenviar o código Pix — só confirma que já está tudo certo.
    const jaPago = valorEfetivo !== 0 && dados.pagamento?.status === "pago";
    const corpos: Record<string, string> = {
      aprovado: valorEfetivo === 0
        ? `<p><b>Início:</b> ${dados.dataInicio || "não informado"}<br><b>Fim:</b> ${dados.dataFim || "não informado"}</p><p>Este campeonato foi liberado sem custo. Já está disponível para uso dentro desse período.</p>`
        : jaPago
          ? `<p><b>Início:</b> ${dados.dataInicio || "não informado"}<br><b>Fim:</b> ${dados.dataFim || "não informado"}</p><p>O pagamento das diárias já tinha sido confirmado. Este campeonato já está disponível para uso dentro desse período.</p>`
          : dados.pagamento?.status === "pendente" && dados.pagamento?.copiaCola
            ? `<p><b>Início:</b> ${dados.dataInicio || "não informado"}<br><b>Fim:</b> ${dados.dataFim || "não informado"}</p>
               <p><b>Valor das diárias:</b> R$ ${valorEfetivo.toFixed(2).replace(".", ",")}${diasCalc ? ` (${diasCalc} diária${diasCalc > 1 ? "s" : ""})` : ""}</p>
               <p>Pague via Pix usando o código copia-e-cola abaixo (ou escaneie o QR direto no app):</p>
               <p style="word-break:break-all;font-family:monospace;background:#f4f4f4;padding:8px;border-radius:6px;">${dados.pagamento.copiaCola}</p>
               <p>Assim que o pagamento for identificado, o campeonato é liberado automaticamente.</p>`
            : `<p><b>Início:</b> ${dados.dataInicio || "não informado"}<br><b>Fim:</b> ${dados.dataFim || "não informado"}</p>
               <p><b>Valor das diárias:</b> R$ ${valorEfetivo.toFixed(2).replace(".", ",")}${diasCalc ? ` (${diasCalc} diária${diasCalc > 1 ? "s" : ""})` : ""}</p>
               <p>Falta só o pagamento via Pix para liberar o uso — entre no app para gerar o código.</p>`,
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

  return json({ ...meta, pagamento: dados.pagamento ?? null });
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

/* ============================================================
   APITAR JOGO — link de árbitro convidado (público, mas restrito)
   Permite compartilhar um link que dá acesso SÓ ao placar/cronômetro de UMA partida
   específica — nada mais do torneio (sem outras partidas, sem telefones de duplas, sem
   configurações). Protegido por um token aleatório específico daquela partida: quem não tem
   o link não consegue nem ler nem alterar nada, diferente do "Placar para TV" (que só usa o
   ID do torneio) — aqui exigimos também esse token porque essa rota permite ESCREVER dados.
============================================================ */
function getMatchRef(state: any, matchId: string): any | null {
  if (!state) return null;
  if (/^g\d+$/.test(matchId)) {
    const idx = Number(matchId.slice(1));
    return state.groupMatches?.[idx] || null;
  }
  if (matchId === "terceiro") {
    return state.terceiro || null;
  }
  let m = matchId.match(/^e(\d+)_(\d+)$/);
  if (m) {
    return state.elimRodadas?.[Number(m[1])]?.matches?.[Number(m[2])] || null;
  }
  m = matchId.match(/^b(\d+)_(\d+)$/);
  if (m) {
    return state.bracket?.[Number(m[1])]?.[Number(m[2])] || null;
  }
  return null;
}

// Mesma regra do cliente: troca de lado a cada múltiplo de 6 pontos somados (soma dos dois placares).
function checkTrocaLado(arb: any): boolean {
  const soma = (arb.placarA || 0) + (arb.placarB || 0);
  const multiploAtual = soma > 0 ? Math.floor(soma / 6) * 6 : 0;
  let deveTrocar = false;
  if (multiploAtual > 0 && multiploAtual > (arb.ultimoMultiploTroca || 0)) {
    arb.ultimoMultiploTroca = multiploAtual;
    deveTrocar = true;
  } else if (soma < (arb.ultimoMultiploTroca || 0)) {
    arb.ultimoMultiploTroca = multiploAtual;
  }
  return deveTrocar;
}

// Se a partida já tem placar definido direto (sem passar pelo apito), o registro nasce
// refletindo esse placar e status real em vez de zerado/não iniciada — mesma regra do front
// (getArb no index.html). Sem isso, um jogo já finalizado "renascia" como não iniciado ao
// gerar o link de árbitro, e essa inconsistência fazia o jogo parecer reaberto.
function defaultArb(m?: any): any {
  const temPlacar = m && m.pa !== null && m.pa !== undefined && m.pa !== "" && m.pb !== null && m.pb !== undefined && m.pb !== "";
  const finalizado = !!(m && m.finalizado);
  return {
    status: finalizado ? "finalizada" : "nao_iniciada",
    placarA: temPlacar ? Number(m.pa) : 0,
    placarB: temPlacar ? Number(m.pb) : 0,
    acumuladoMs: 0,
    inicioMs: null,
    ultimoMultiploTroca: 0,
    duracaoFinalSegundos: finalizado ? 0 : null,
    arbitroNome: null,
    tokenApito: null,
    atualizadoEm: Date.now() // usado pelo merge em torneiosSave pra saber qual lado é mais recente
  };
}

// Auto-corrige (em memória, mutando) um registro de arbitragem já existente que ficou
// desalinhado com o jogo — jogo finalizado com arbitragem parada em "não iniciada" (bug
// antigo já corrigido no código, mas pode ter deixado dados salvos assim antes do ajuste).
function corrigirArb(arb: any, m: any): any {
  if (m && m.finalizado && arb.status !== "finalizada") {
    arb.status = "finalizada";
    arb.placarA = Number(m.pa);
    arb.placarB = Number(m.pb);
    arb.inicioMs = null;
    if (arb.duracaoFinalSegundos == null) arb.duracaoFinalSegundos = Math.floor((arb.acumuladoMs || 0) / 1000);
    arb.atualizadoEm = Date.now();
  }
  return arb;
}

// Autenticado (dono do torneio ou admin): gera (ou reaproveita) o token do link de árbitro
// convidado pra uma partida específica.
async function apitoCriarLink(request: Request, env: Env): Promise<Response> {
  let body: any;
  try {
    body = await request.json();
  } catch {
    return json({ error: "JSON inválido" }, 400);
  }

  const torneioId = body.id;
  const matchId = body.match;
  const solicitanteEmail = normEmail(body.email);
  if (!torneioId || !matchId) return json({ error: "id e match são obrigatórios" }, 400);
  if (!solicitanteEmail) return json({ error: "email obrigatório" }, 400);

  const raw = await env.DB.get(`torneio:${torneioId}`);
  if (!raw) return json({ error: "não encontrado" }, 404);
  const dados = JSON.parse(raw);

  if (normEmail(dados.ownerEmail) !== solicitanteEmail && !ehAdmin(solicitanteEmail, env)) {
    return json({ error: "Sem permissão para gerar link deste torneio" }, 403);
  }

  const matchRef = getMatchRef(dados.state, matchId);
  if (!matchRef) return json({ error: "jogo não encontrado" }, 404);

  if (!dados.state.arbitragem) dados.state.arbitragem = {};
  const arb = corrigirArb(dados.state.arbitragem[matchId] || defaultArb(matchRef), matchRef);
  if (!arb.tokenApito) arb.tokenApito = crypto.randomUUID();
  dados.state.arbitragem[matchId] = arb;

  try {
    await env.DB.put(`torneio:${torneioId}`, JSON.stringify(dados));
  } catch (e: any) {
    return json({ error: "Falha ao salvar", detail: String(e?.message || e) }, 500);
  }

  return json({ ok: true, token: arb.tokenApito });
}

// Público (com token): devolve só o placar/status/nome do árbitro daquela partida — nada mais
// do torneio.
async function apitoGet(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const torneioId = url.searchParams.get("torneio");
  const matchId = url.searchParams.get("match");
  const token = url.searchParams.get("token");
  if (!torneioId || !matchId || !token) return json({ error: "torneio, match e token são obrigatórios" }, 400);

  const raw = await env.DB.get(`torneio:${torneioId}`);
  if (!raw) return json({ error: "não encontrado" }, 404);
  const dados = JSON.parse(raw);

  const refPublico = getMatchRef(dados.state, matchId);
  if (!refPublico) return json({ error: "jogo não encontrado" }, 404);
  const arb = dados.state?.arbitragem?.[matchId];
  if (!arb || !arb.tokenApito || arb.tokenApito !== token) return json({ error: "Link inválido ou expirado" }, 403);
  if (torneioExpirado(dados.dataFim)) return json({ error: "Esse campeonato já foi encerrado — não é mais possível apitar." }, 403);

  return json({ ok: true, arb: corrigirArb(arb, refPublico) });
}

// Público (com token): executa uma ação de arbitragem (iniciar, ponto, tempo técnico,
// finalizar, reabrir) — só nessa partida, via leitura+escrita direcionada no registro
// completo (nunca sobrescreve o torneio inteiro).
async function apitoPost(request: Request, env: Env): Promise<Response> {
  let body: any;
  try {
    body = await request.json();
  } catch {
    return json({ error: "JSON inválido" }, 400);
  }

  const torneioId = body.torneio;
  const matchId = body.match;
  const token = body.token;
  const action = body.action;
  if (!torneioId || !matchId || !token || !action) {
    return json({ error: "torneio, match, token e action são obrigatórios" }, 400);
  }

  const raw = await env.DB.get(`torneio:${torneioId}`);
  if (!raw) return json({ error: "não encontrado" }, 404);
  const dados = JSON.parse(raw);

  const m = getMatchRef(dados.state, matchId);
  if (!m) return json({ error: "jogo não encontrado" }, 404);
  if (!dados.state.arbitragem) dados.state.arbitragem = {};
  const arb: any = corrigirArb(dados.state.arbitragem[matchId] || defaultArb(m), m);
  if (!arb.tokenApito || arb.tokenApito !== token) return json({ error: "Link inválido ou expirado" }, 403);
  if (torneioExpirado(dados.dataFim)) return json({ error: "Esse campeonato já foi encerrado — não é mais possível apitar." }, 403);

  if (typeof body.arbitroNome === "string" && body.arbitroNome.trim()) {
    arb.arbitroNome = body.arbitroNome.trim().slice(0, 60);
  }

  let trocarLado = false;
  let finalizouAgora = false;
  if (action === "iniciar") {
    if (arb.status === "nao_iniciada") {
      arb.inicioMs = Date.now();
      arb.status = "andamento";
      arb.atualizadoEm = Date.now();
    }
  } else if (action === "tempoTecnico") {
    if (arb.status === "andamento") {
      arb.acumuladoMs += Date.now() - (arb.inicioMs || Date.now());
      arb.inicioMs = null;
      arb.status = "tecnico";
      arb.atualizadoEm = Date.now();
    } else if (arb.status === "tecnico") {
      arb.inicioMs = Date.now();
      arb.status = "andamento";
      arb.atualizadoEm = Date.now();
    }
  } else if (action === "ponto") {
    if (arb.status !== "finalizada") {
      const lado = body.lado === "b" ? "b" : "a";
      const delta = body.delta === -1 ? -1 : 1;
      const campo = lado === "a" ? "placarA" : "placarB";
      arb[campo] = Math.max(0, (arb[campo] || 0) + delta);
      arb.atualizadoEm = Date.now();
      trocarLado = checkTrocaLado(arb);
      m.pa = arb.placarA;
      m.pb = arb.placarB;
    }
  } else if (action === "finalizar") {
    if (arb.status === "andamento" || arb.status === "tecnico") {
      if (arb.status === "andamento" && arb.inicioMs) {
        arb.acumuladoMs += Date.now() - arb.inicioMs;
        arb.inicioMs = null;
      }
      arb.status = "finalizada";
      arb.duracaoFinalSegundos = Math.floor(arb.acumuladoMs / 1000);
      arb.atualizadoEm = Date.now();
      m.pa = arb.placarA;
      m.pb = arb.placarB;
      m.finalizado = true;
      finalizouAgora = true;
    }
  } else if (action === "reabrir") {
    if (arb.status === "finalizada") {
      arb.status = "tecnico";
      arb.atualizadoEm = Date.now();
      m.finalizado = false;
    }
  } else {
    return json({ error: "ação inválida" }, 400);
  }

  dados.state.arbitragem[matchId] = arb;
  dados.updatedAt = new Date().toISOString();

  try {
    await env.DB.put(`torneio:${torneioId}`, JSON.stringify(dados));
  } catch (e: any) {
    return json({ error: "Falha ao salvar", detail: String(e?.message || e) }, 500);
  }
  if (finalizouAgora) {
    await registrarLogs(env, [{
      tipo: "resultado_registrado",
      atorEmail: null,
      atorNome: arb.arbitroNome || "Árbitro convidado",
      torneioId,
      torneioNome: dados.nome,
      torneioCodigo: dados.codigo,
      descricao: `Jogo finalizado via link de árbitro: ${m.a || "?"} ${m.pa ?? "-"} x ${m.pb ?? "-"} ${m.b || "?"}`,
      dados: { matchId, a: m.a, b: m.b, pa: m.pa, pb: m.pb }
    }]);
  }

  return json({ ok: true, arb, finalizado: !!m.finalizado, trocarLado });
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
   Regra de valor: R$ X,00 por diária (configurável pelo admin, padrão R$ 70,00), diária = cada
   dia dentro do período de validade (dataInicio..dataFim) que o próprio organizador escolhe ao
   criar o torneio. O Pix é gerado automaticamente nesse momento (torneiosSave), sem esperar a
   aprovação do admin — a aprovação passou a ser uma revisão em paralelo, não um pré-requisito
   pro pagamento. Só fica bloqueado se o torneio for recusado ou bloqueado depois.
============================================================ */
const VALOR_DIARIA_PADRAO = 70;

// Valor da diária configurável pelo admin (aba Configurações do app); cai pro padrão se nunca
// foi definido ou se o que estiver salvo não for um número válido.
async function getValorDiaria(env: Env): Promise<number> {
  const raw = await env.DB.get("config:valor_diaria");
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : VALOR_DIARIA_PADRAO;
}

// Desconto do cupom aplica sobre o subtotal automático (dias × valor da diária) — nunca sobre um
// valorOverride definido manualmente pelo admin na aprovação, que é sempre a palavra final.
function calcularValorComCupom(dias: number, cupomAplicado: { percentual: number } | null | undefined, valorDiaria: number): number {
  const subtotal = dias * valorDiaria;
  const desconto = cupomAplicado?.percentual ? subtotal * (cupomAplicado.percentual / 100) : 0;
  return Math.max(0, subtotal - desconto);
}

function calcularDias(dataInicio?: string | null, dataFim?: string | null): number {
  if (!dataInicio || !dataFim) return 0;
  const ini = new Date(dataInicio + "T00:00:00Z").getTime();
  const fim = new Date(dataFim + "T00:00:00Z").getTime();
  if (Number.isNaN(ini) || Number.isNaN(fim) || fim < ini) return 0;
  return Math.round((fim - ini) / 86400000) + 1;
}

// Núcleo da geração de cobrança Pix — reaproveitado pela geração automática na criação
// (torneiosSave), pela geração automática na aprovação como rede de segurança caso a primeira
// tentativa tenha falhado (torneiosAprovar), e pela rota manual (pixCriar, botão "Gerar Pix" no
// app, usado só se as duas automáticas não derem certo). Lê e grava o torneio direto do KV (não
// recebe `dados` pronto de fora) pra sempre operar em cima da versão mais recente já persistida,
// evitando sobrescrever uma aprovação que acabou de ser salva.
async function gerarCobrancaPix(env: Env, id: string, origin: string, solicitanteEmail?: string): Promise<
  | { ok: true; pagamento: any; aprovacaoStatus: string; recuperadoPorBusca?: boolean }
  | { ok: false; error: string; status: number }
> {
  if (!env.MP_ACCESS_TOKEN) {
    return { ok: false, error: "Pagamento via Pix não configurado neste servidor (MP_ACCESS_TOKEN ausente)", status: 500 };
  }

  const raw = await env.DB.get(`torneio:${id}`);
  if (!raw) return { ok: false, error: "não encontrado", status: 404 };
  const dados = JSON.parse(raw);

  // O pagamento não depende mais da aprovação — é gerado assim que o torneio é criado, com as
  // datas e o cupom que o próprio organizador já escolheu no formulário. A aprovação do admin
  // acontece em paralelo. Só bloqueia Pix pra torneio recusado ou bloqueado.
  if (dados.aprovacaoStatus === "recusado" || dados.aprovacaoStatus === "bloqueado") {
    return { ok: false, error: "Este torneio foi recusado ou está bloqueado — não é possível gerar Pix", status: 400 };
  }
  if (dados.pagamento?.status === "pago") {
    return { ok: false, error: "Este torneio já está pago", status: 400 };
  }

  // Proteção extra: se o registro de pagamento tiver sido perdido por algum motivo, busca no
  // Mercado Pago se já existe um pagamento aprovado pra este torneio antes de gerar uma
  // cobrança nova — evita cobrar duas vezes por engano.
  const jaAprovado = await buscarPagamentoPorReferencia(env, id);
  if (jaAprovado) {
    const atualizado = await confirmarPagamentoAprovado(env, id, jaAprovado);
    return {
      ok: true,
      pagamento: atualizado?.pagamento || dados.pagamento,
      aprovacaoStatus: atualizado?.aprovacaoStatus || dados.aprovacaoStatus,
      recuperadoPorBusca: true
    };
  }

  const dias = calcularDias(dados.dataInicio, dados.dataFim);
  if (dias <= 0) {
    return { ok: false, error: "Datas de início/fim inválidas para calcular o valor da diária", status: 400 };
  }
  const valorDiaria = await getValorDiaria(env);
  const valor = (typeof dados.valorOverride === "number" && dados.valorOverride >= 0)
    ? dados.valorOverride
    : calcularValorComCupom(dias, dados.cupomAplicado, valorDiaria);
  if (valor <= 0) {
    return { ok: false, error: "O valor está zerado — esse torneio já deveria ter sido liberado automaticamente na aprovação, sem precisar de Pix.", status: 400 };
  }

  const notificationUrl = `${origin}/api/pix-webhook`;

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
    if (!res.ok) return { ok: false, error: "Falha ao criar cobrança no Mercado Pago", status: 502 };
  } catch (e: any) {
    return { ok: false, error: "Falha de rede ao falar com o Mercado Pago", status: 502 };
  }

  const txData = mpResp?.point_of_interaction?.transaction_data;
  if (!txData?.qr_code) {
    return { ok: false, error: "Mercado Pago não retornou o código Pix", status: 502 };
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
    return { ok: false, error: "Falha ao salvar", status: 500 };
  }

  return { ok: true, pagamento: dados.pagamento, aprovacaoStatus: dados.aprovacaoStatus };
}

async function pixCriar(request: Request, env: Env): Promise<Response> {
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

  const resultado = await gerarCobrancaPix(env, id, new URL(request.url).origin, solicitanteEmail);
  if (!resultado.ok) return json({ error: resultado.error }, resultado.status);
  return json({ ok: true, pagamento: resultado.pagamento, aprovacaoStatus: resultado.aprovacaoStatus, recuperadoPorBusca: resultado.recuperadoPorBusca });
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
  // Pagamento confirmado libera o torneio na hora — não precisa mais esperar uma aprovação manual
  // separada do admin (que continua podendo recusar/bloquear depois, se precisar; só não é mais
  // um pré-requisito pro uso). Só avança de "pendente" pra "aprovado" — nunca mexe se já tiver
  // sido explicitamente recusado ou bloqueado.
  if (dados.aprovacaoStatus === "pendente") {
    dados.aprovacaoStatus = "aprovado";
  }
  dados.updatedAt = new Date().toISOString();

  try {
    await env.DB.put(`torneio:${torneioId}`, JSON.stringify(dados));
    const index = await getIndex(env);
    const idx = index.findIndex((t: any) => t.id === torneioId);
    if (idx >= 0) {
      index[idx].pagamentoStatus = "pago";
      index[idx].aprovacaoStatus = dados.aprovacaoStatus;
      await env.DB.put("torneios:index", JSON.stringify(index));
    }
  } catch {}

  if (dados.ownerEmail) {
    const valorTexto = typeof dados.pagamento?.valor === "number" ? `R$ ${dados.pagamento.valor.toFixed(2).replace(".", ",")}` : null;
    await enviarEmail(
      env,
      dados.ownerEmail,
      `Pagamento confirmado — campeonato [${dados.codigo}] "${dados.nome}"`,
      `<p>Olá${dados.ownerName ? ", " + dados.ownerName : ""}!</p>
       <p>Recebemos o pagamento das diárias do campeonato <b>${dados.nome}</b> (código <b>${dados.codigo}</b>)${valorTexto ? ` no valor de <b>${valorTexto}</b>` : ""}. Ele já está liberado para uso.</p>`
    );
  }
  const adminEmail = await env.DB.get("config:admin_notification_email");
  if (adminEmail) {
    const valorTexto = typeof dados.pagamento?.valor === "number" ? `R$ ${dados.pagamento.valor.toFixed(2).replace(".", ",")}` : "valor não identificado";
    await enviarEmail(
      env,
      adminEmail,
      `💰 Pagamento recebido [${dados.codigo}]`,
      `<p>O campeonato <b>${dados.nome}</b> (código <b>${dados.codigo}</b>) teve o pagamento confirmado via Pix, no valor de <b>${valorTexto}</b>.</p>`
    );
  }

  return dados;
}

// Recuperação: busca no Mercado Pago se já existe um pagamento aprovado pra este torneio,
// usando o external_reference (que é sempre o id do torneio) — sem depender do paymentId
// estar salvo no nosso banco. Cobre casos em que esse campo se perdeu por algum motivo (ex: o
// bug antigo do torneios-save, já corrigido) e serve de rede de segurança geral daqui pra frente.
async function buscarPagamentoPorReferencia(env: Env, torneioId: string): Promise<any | null> {
  if (!env.MP_ACCESS_TOKEN) return null;
  try {
    const url = `https://api.mercadopago.com/v1/payments/search?external_reference=${encodeURIComponent(torneioId)}&sort=date_created&criteria=desc`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${env.MP_ACCESS_TOKEN}` } });
    if (!res.ok) return null;
    const data: any = await res.json();
    const results: any[] = Array.isArray(data?.results) ? data.results : [];
    return results.find((p: any) => p?.status === "approved") || null;
  } catch {
    return null;
  }
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
    return json({ ok: true, pagamento: dados.pagamento, aprovacaoStatus: dados.aprovacaoStatus });
  }

  const paymentId = dados.pagamento?.paymentId;
  if (!paymentId) {
    // Sem paymentId salvo (ex: torneio afetado pelo bug antigo, já corrigido, que perdia esse
    // campo em salvamentos normais) — tenta recuperar buscando direto no Mercado Pago.
    const encontrado = await buscarPagamentoPorReferencia(env, id);
    if (encontrado) {
      const atualizado = await confirmarPagamentoAprovado(env, id, encontrado);
      return json({
        ok: true,
        pagamento: atualizado?.pagamento || dados.pagamento,
        aprovacaoStatus: atualizado?.aprovacaoStatus || dados.aprovacaoStatus,
        recuperadoPorBusca: true
      });
    }
    return json({ ok: true, pagamento: dados.pagamento || null, aprovacaoStatus: dados.aprovacaoStatus });
  }

  try {
    const res = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
      headers: { Authorization: `Bearer ${env.MP_ACCESS_TOKEN}` }
    });
    if (!res.ok) return json({ ok: true, pagamento: dados.pagamento, aprovacaoStatus: dados.aprovacaoStatus, statusMercadoPago: null });
    const pagamentoMP = await res.json();

    if (pagamentoMP?.status === "approved") {
      const atualizado = await confirmarPagamentoAprovado(env, id, pagamentoMP);
      return json({
        ok: true,
        pagamento: atualizado?.pagamento || dados.pagamento,
        aprovacaoStatus: atualizado?.aprovacaoStatus || dados.aprovacaoStatus
      });
    }
    return json({ ok: true, pagamento: dados.pagamento, aprovacaoStatus: dados.aprovacaoStatus, statusMercadoPago: pagamentoMP?.status || null });
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
  // valorDiaria é pública (não só pro admin) — qualquer um precisa dela pra mostrar o preview de
  // preço na tela de criação de torneio.
  const resposta: any = { googleClientId, isAdmin, valorDiaria: await getValorDiaria(env) };
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
  if (typeof body.valorDiaria === "number" && Number.isFinite(body.valorDiaria) && body.valorDiaria > 0) {
    await env.DB.put("config:valor_diaria", String(body.valorDiaria));
  }

  return json({ ok: true });
}

/* ============================================================
   LOGIN GOOGLE — FLUXO REDIRECT
   Alternativa ao popup padrão do Google Identity Services (ux_mode:"redirect" em vez de
   "popup"), mais confiável em navegadores com Intelligent Tracking Prevention (Safari é o
   caso clássico) — lá o popup às vezes trava ao tentar "Usar outra conta", já que a troca de
   conta acontece dentro do próprio popup isolado pelo ITP. No modo redirect, o Google navega a
   aba inteira pra accounts.google.com e depois faz um POST de volta aqui com o credential.
============================================================ */
async function googleLoginCallback(request: Request, env: Env): Promise<Response> {
  // Proteção contra CSRF documentada pelo Google pra esse fluxo: o próprio Google Identity
  // Services já seta um cookie "g_csrf_token" no domínio do app antes de redirecionar pro
  // login — o valor que vier de volta no corpo do POST precisa bater com esse cookie. Sem essa
  // checagem, qualquer site poderia forjar um POST pra essa rota fingindo ser um login legítimo.
  const cookieHeader = request.headers.get("Cookie") || "";
  const cookieMatch = cookieHeader.match(/(?:^|;\s*)g_csrf_token=([^;]+)/);
  const cookieToken = cookieMatch ? decodeURIComponent(cookieMatch[1]) : null;

  let credential = "";
  let bodyToken = "";
  try {
    const form = await request.formData();
    credential = String(form.get("credential") || "");
    bodyToken = String(form.get("g_csrf_token") || "");
  } catch {
    return new Response("Requisição de login inválida.", { status: 400 });
  }

  if (!cookieToken || !bodyToken || cookieToken !== bodyToken) {
    return new Response("Falha na verificação de segurança do login. Tente novamente.", { status: 400 });
  }
  if (!credential) {
    return new Response("Credencial do Google ausente.", { status: 400 });
  }

  // Só decodifica o JWT (não verifica assinatura) — igual ao fluxo popup já fazia no front
  // (decodeJwt em index.html). A autorização de verdade continua sendo feita pelo servidor em
  // cada rota protegida, comparando o e-mail com ADMIN_EMAILS — esse login em si nunca foi o
  // limite de segurança do app.
  let payload: any;
  try {
    const parte = credential.split(".")[1];
    const b64 = parte.replace(/-/g, "+").replace(/_/g, "/");
    payload = JSON.parse(atob(b64));
  } catch {
    return new Response("Não foi possível ler a credencial do Google.", { status: 400 });
  }
  if (!payload?.email) {
    return new Response("Credencial do Google sem e-mail.", { status: 400 });
  }

  const auth = { email: payload.email, name: payload.name || "", picture: payload.picture || "" };
  // JSON.stringify duas vezes: a primeira serializa o objeto auth, a segunda transforma esse
  // JSON num literal de string JS seguro pra colocar dentro do <script> abaixo. Escapa "<" à
  // parte porque nada impede alguém de nomear a própria conta Google com algo tipo
  // "</script><script>...", o que fecharia a tag cedo e injetaria HTML/JS na página.
  const authLiteral = JSON.stringify(JSON.stringify(auth)).replace(/</g, "\\u003c");

  const html = `<!doctype html><html><body><script>
try{ localStorage.setItem("futevolei_auth_v1", ${authLiteral}); }catch(e){}
location.replace("/");
</script></body></html>`;

  await registrarLogs(env, [{
    tipo: "acesso",
    atorEmail: auth.email,
    atorNome: auth.name || null,
    torneioId: null,
    torneioNome: null,
    torneioCodigo: null,
    descricao: `Login de ${auth.name || auth.email}`
  }]);

  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

/* ============================================================
   LOG DE ATIVIDADE (admin)
   Trilha de auditoria leve: login, criação de torneio, sorteio de duplas e jogos finalizados —
   guardada numa única chave (logs:index, lista completa, mesmo esquema de cupons:index), capada
   em LOGS_MAX entradas mais recentes pra não crescer pra sempre (cada gravação relê e regrava o
   blob inteiro; sem cap, isso ficaria cada vez mais pesado com o tempo). Uma falha ao gravar log
   nunca pode derrubar a ação principal que originou o evento — por isso registrarLogs engole
   qualquer erro.
============================================================ */
interface LogEntry {
  id: string;
  tipo: "acesso" | "torneio_criado" | "duplas_sorteadas" | "resultado_registrado";
  quando: string;
  atorEmail: string | null;
  atorNome: string | null;
  torneioId: string | null;
  torneioNome: string | null;
  torneioCodigo: string | null;
  descricao: string;
  dados?: any;
}
const LOGS_MAX = 2000;
async function getLogs(env: Env): Promise<LogEntry[]> {
  try {
    const raw = await env.DB.get("logs:index");
    if (raw) return JSON.parse(raw);
  } catch {}
  return [];
}
async function registrarLogs(env: Env, novos: Array<Omit<LogEntry, "id" | "quando">>): Promise<void> {
  if (!novos.length) return;
  try {
    const lista = await getLogs(env);
    const quando = new Date().toISOString();
    for (const n of novos) lista.push({ ...n, id: crypto.randomUUID(), quando });
    const cortada = lista.length > LOGS_MAX ? lista.slice(lista.length - LOGS_MAX) : lista;
    await env.DB.put("logs:index", JSON.stringify(cortada));
  } catch {
    // auditoria não pode derrubar a ação principal que originou o evento
  }
}
// Enumera todos os jogos de um state (grupos, eliminação, mata-mata, 3º lugar) junto com o
// matchId de cada um — usado pra comparar antes/depois e detectar transições relevantes (sorteio
// feito, jogo finalizado) sem duplicar em vários lugares a lógica de "qual formato é esse jogo".
function listarTodosMatches(state: any): { matchId: string; m: any }[] {
  const lista: { matchId: string; m: any }[] = [];
  (state?.groupMatches || []).forEach((m: any, idx: number) => lista.push({ matchId: `g${idx}`, m }));
  (state?.elimRodadas || []).forEach((r: any, ri: number) => {
    (r?.matches || []).forEach((m: any, mi: number) => lista.push({ matchId: `e${ri}_${mi}`, m }));
  });
  (state?.bracket || []).forEach((round: any, ri: number) => {
    (round || []).forEach((m: any, mi: number) => lista.push({ matchId: `b${ri}_${mi}`, m }));
  });
  if (state?.terceiro) lista.push({ matchId: "terceiro", m: state.terceiro });
  return lista;
}

async function logList(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const solicitanteEmail = normEmail(url.searchParams.get("email"));
  if (!ehAdmin(solicitanteEmail, env)) return json({ error: "Só o admin pode ver os logs" }, 403);
  return json({ logs: await getLogs(env) });
}

// Usada pelo fallback popup do login (ux_mode:"redirect" já loga direto em googleLoginCallback;
// isso só cobre o caso raro de o navegador cair no popup padrão do Google Identity Services).
async function logAcesso(request: Request, env: Env): Promise<Response> {
  let body: any;
  try {
    body = await request.json();
  } catch {
    return json({ error: "JSON inválido" }, 400);
  }
  const email = normEmail(body.email);
  if (!email) return json({ error: "email obrigatório" }, 400);
  const nome = typeof body.name === "string" && body.name.trim() ? body.name.trim().slice(0, 120) : null;
  await registrarLogs(env, [{
    tipo: "acesso",
    atorEmail: email,
    atorNome: nome,
    torneioId: null,
    torneioNome: null,
    torneioCodigo: null,
    descricao: `Login de ${nome || email}`
  }]);
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
    if (path === "/api/apito-link") {
      return method === "POST" ? apitoCriarLink(request, env) : new Response("Method not allowed", { status: 405 });
    }
    if (path === "/api/apito") {
      if (method === "GET") return apitoGet(request, env);
      if (method === "POST") return apitoPost(request, env);
      return new Response("Method not allowed", { status: 405 });
    }
    if (path === "/api/torneios-delete") {
      return method === "POST" || method === "DELETE"
        ? torneiosDelete(request, env)
        : new Response("Method not allowed", { status: 405 });
    }
    if (path === "/api/torneios-aprovar") {
      return method === "POST" ? torneiosAprovar(request, env) : new Response("Method not allowed", { status: 405 });
    }
    if (path === "/api/torneios-comissao") {
      return method === "POST" ? torneiosComissao(request, env) : new Response("Method not allowed", { status: 405 });
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
    if (path === "/api/cupons-list") {
      return cuponsList(request, env);
    }
    if (path === "/api/cupons-salvar") {
      return method === "POST" ? cuponsSalvar(request, env) : new Response("Method not allowed", { status: 405 });
    }
    if (path === "/api/cupons-remover") {
      return method === "POST" ? cuponsRemover(request, env) : new Response("Method not allowed", { status: 405 });
    }
    if (path === "/api/cupons-bloquear") {
      return method === "POST" ? cuponsBloquear(request, env) : new Response("Method not allowed", { status: 405 });
    }
    if (path === "/api/cupons-editar-comissao") {
      return method === "POST" ? cuponsEditarComissao(request, env) : new Response("Method not allowed", { status: 405 });
    }
    if (path === "/api/cupons-validar") {
      return cuponsValidar(request, env);
    }
    if (path === "/api/config-get") {
      return configGet(request, env);
    }
    if (path === "/api/config-set") {
      return method === "POST" ? configSet(request, env) : new Response("Method not allowed", { status: 405 });
    }
    if (path === "/api/google-login-callback") {
      return method === "POST" ? googleLoginCallback(request, env) : new Response("Method not allowed", { status: 405 });
    }
    if (path === "/api/log-list") {
      return logList(request, env);
    }
    if (path === "/api/log-acesso") {
      return method === "POST" ? logAcesso(request, env) : new Response("Method not allowed", { status: 405 });
    }
    if (path.startsWith("/api/")) {
      return new Response("Not found", { status: 404 });
    }

    return env.ASSETS.fetch(request);
  }
};
