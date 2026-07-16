# App do Campeonato de Futevôlei

PWA para organizar campeonatos de futevôlei: sorteio de duplas, fase de grupos ou eliminação
simples, mata-mata, notificações por WhatsApp/Telegram, cobrança das diárias via Pix (Mercado
Pago), aprovação de torneios por um admin, link de árbitro convidado, modo claro/escuro, e
geração de imagem pra Stories do Instagram.

- **Site:** `https://campeonato-futevolei.thiagobaptistella.workers.dev`
- **Hospedagem:** Cloudflare Workers (com Cloudflare Workers Builds — deploy automático a cada
  push no GitHub, sem GitHub Actions próprio)
- **Repositório:** `thiagorcesario1983/campeonato-futevolei`

## Comandos

```bash
npx wrangler dev        # rodar localmente
npx wrangler deploy     # deploy manual (normalmente não precisa — o push já dispara)
npx wrangler secret list  # ver quais secrets estão configurados (sem mostrar o valor)
```

Não existe suíte de testes automatizada. Antes de considerar uma mudança pronta:
1. Valide a sintaxe do JS embutido no `index.html` (ele é um `<script>` gigante dentro do HTML):
   ```bash
   python3 -c "
   import re
   html = open('public/index.html', encoding='utf-8').read()
   scripts = re.findall(r'<script>(.*?)</script>', html, re.S)
   open('/tmp/check.js','w',encoding='utf-8').write(max(scripts, key=len))
   "
   node --check /tmp/check.js
   ```
2. Pra mudanças em funções específicas, vale simular a execução com um stub mínimo de
   `document`/`window`/`localStorage` e chamar a função diretamente com dados falsos, em vez de
   confiar só no `node --check` (sintaxe válida não significa que a função roda sem erro).
3. Type-check do Worker:
   ```bash
   npx tsc --noEmit --target es2022 --lib es2022,webworker --skipLibCheck src/worker.ts
   ```
   (vai reclamar de `KVNamespace`/`Fetcher`/`ExecutionContext`/`cloudflare:sockets` faltando —
   isso é só porque faltam os tipos do `@cloudflare/workers-types` no ambiente de teste, ignore.)

## Arquitetura

```
campeonato-futevolei/
├── public/
│   ├── index.html          ← TODO o front-end: HTML + CSS + JS num arquivo só (sem build step)
│   ├── manifest.json
│   ├── service-worker.js   ← cache offline, estratégia network-first
│   └── icons/
├── src/
│   └── worker.ts           ← TODA a API/backend num Worker só
├── wrangler.jsonc
└── package.json
```

- **Front-end**: `index.html` é um arquivo único, sem framework, sem bundler. Estado do app é um
  objeto `state` (ver `defaultState()`), persistido em `localStorage` e sincronizado com a nuvem
  via `save()` → `syncTorneio()` (debounce de 800ms) → `POST /api/torneios-save`.
- **Back-end**: um Worker só, roteando `/api/*` e servindo os arquivos estáticos (`assets`) pra
  tudo o mais.
- **Banco**: Cloudflare KV, namespace `campeonato-futevolei-db`. Cada torneio é uma chave
  `torneio:{id}` (JSON completo, incluindo `state`), mais `torneios:index` (resumo leve de todos,
  usado pra listagem rápida) e `telegram:{codigo}` (chat_id do Telegram por dupla/torneio).

## Variáveis de ambiente / Secrets (painel Cloudflare → Settings → Variables and Secrets)

| Nome | O que é |
|---|---|
| `SMTP_HOST` | `smtp.gmail.com` (fixo) |
| `SMTP_PORT` | `587` (fixo) |
| `SMTP_USER` | e-mail Gmail completo usado pra enviar notificações |
| `SMTP_PASS` | **Senha de app** de 16 caracteres do Gmail (não é a senha normal — precisa 2FA ativado na conta) |
| `ADMIN_EMAILS` | e-mails Google reais com permissão de admin, separados por vírgula |
| `TELEGRAM_BOT_TOKEN` | token do bot criado via `@BotFather` |
| `MP_ACCESS_TOKEN` | Access Token de produção do Mercado Pago |
| `MP_WEBHOOK_SECRET` | opcional; chave do webhook configurado no painel do Mercado Pago |

⚠️ **`wrangler.jsonc` precisa ter `"keep_vars": true`** no nível raiz. Sem isso, o Wrangler trata
"nenhuma variável declarada no arquivo" como a configuração correta e apaga tudo que só existe no
painel a cada deploy — foi exatamente isso que apagava `ADMIN_EMAILS` sozinho. Não adicione essas
variáveis dentro de um bloco `"vars"` no `wrangler.jsonc` — elas devem existir só no painel.

Webhook do Telegram: se o domínio do site mudar, reconfigurar via
`https://api.telegram.org/bot{TOKEN}/setWebhook?url=https://SEU-DOMINIO/api/telegram-webhook`.

Webhook do Mercado Pago: painel Mercado Pago Developers → Webhooks → URL
`https://SEU-DOMINIO/api/pix-webhook`, evento `payments`.

## Modelo de dados (dentro de `state`, ver `defaultState()` no index.html)

- `duplas`: `[{nome, tel1, tel2, nomeDefault}]`
- `formato`: `"grupos"` ou `"eliminacao"` — muda como os jogos da 1ª fase são organizados
- `groupMatches` (formato grupos): `[{group, jogo, a, b, pa, pb, finalizado, wo}]`
- `elimRodadas` (formato eliminação): `[{matches:[{a,b,pa,pb,finalizado,wo}], bye}]`
- `bracket`: `[[{pa,pb,finalizado,wo,a,b}], ...]` — cada posição é uma rodada do mata-mata
- `terceiro`: disputa de 3º lugar (opcional)
- `arbitragem`: `{[matchId]: {status, placarA, placarB, acumuladoMs, inicioMs,
  ultimoMultiploTroca, duracaoFinalSegundos, arbitroNome, tokenApito}}` — cronômetro/placar ao
  vivo de cada partida, inclusive as apitadas remotamente pelo link de árbitro convidado
- `pagamento`: `{status:"pendente"|"pago"|"isento", valor, dias, paymentId, copiaCola,
  qrCodeBase64, criadoEm, pagoEm}`
- `valorOverride`: valor do Pix definido manualmente pelo admin na aprovação (sobrescreve o
  cálculo automático de dias × valor da diária)
- Campos de identidade/nuvem que **nunca** devem ser apagados por um reset de jogo: `cloudId`,
  `cloudNome`, `codigo`, `aprovacaoStatus`, `dataInicio`, `dataFim`, `pagamento`, `valorOverride`,
  `headerImage`, `telegramBot`.

`matchId` tem 4 formatos: `g{idx}` (grupo), `terceiro`, `e{rodada}_{jogo}` (eliminação),
`b{rodada}_{jogo}` (mata-mata/bracket). Ver `getMatchObj`/`getMatchRef` no front e `getMatchRef`
no worker.

## Rotas da API (`src/worker.ts`)

| Rota | Método | Autenticação |
|---|---|---|
| `/api/torneios-save` | POST | dono ou admin |
| `/api/torneios-list` | GET | por e-mail |
| `/api/torneios-get` | GET | dono ou admin |
| `/api/torneios-delete` | POST/DELETE | dono ou admin |
| `/api/torneios-tv` | GET | público (só o ID) — "Placar para TV" |
| `/api/torneios-aprovar` | POST | só admin |
| `/api/pix-criar` | POST | dono ou admin |
| `/api/pix-verificar` | POST | dono ou admin — reconsulta o Mercado Pago na hora |
| `/api/pix-webhook` | POST/GET | público, mas valida assinatura + reconfirma na API do MP |
| `/api/apito-link` | POST | dono ou admin — gera token do link de árbitro convidado |
| `/api/apito` | GET/POST | público, mas exige o token daquela partida específica |
| `/api/config-get` / `/api/config-set` | GET / POST | público / só admin |
| `/api/telegram-*` | vário | integração do bot |

Admin é decidido **só pelo servidor**, comparando o e-mail com `ADMIN_EMAILS` (`ehAdmin(email,
env)`). O front nunca guarda essa lista — recebe um `isAdmin: true/false` já resolvido via
`/api/config-get`.

## Decisões e bugs importantes (não repetir)

1. **`torneiosSave` reconstruía o registro inteiro a partir de um resumo leve (`meta`/index)** —
   isso apagava o campo `pagamento` (objeto completo do Pix) a cada salvamento normal do torneio,
   mesmo sem ninguém mexer nele. Corrigido: `torneiosSave` busca o registro completo existente e
   preserva `pagamento`, e faz um merge defensivo de `state.arbitragem` (preservando sempre o
   `tokenApito` do link de árbitro, e mantendo a versão "mais avançada" entre servidor e cliente
   pra não perder pontuação feita por um árbitro remoto). **Qualquer rota nova que salve o torneio
   inteiro de uma vez precisa considerar esse mesmo risco.**
2. **Bracket "bye" era resolvido cedo demais.** `winnerFinal`/`winner` tratavam "adversário nulo"
   como vitória automática (bye) em qualquer rodada — isso fazia o vencedor de uma semifinal ser
   declarado campeão na hora, antes da outra semifinal ou da final acontecerem. Corrigido: bye só
   é permitido na rodada 0 do mata-mata (`permitirBye` como parâmetro extra).
3. **`resetTudo()` fazia `state = defaultState()`**, apagando também `cloudId`/nome/código/
   aprovação/pagamento — e como `syncTorneio()` se recusa a sincronizar sem `cloudId` (por
   design, nunca cria torneio novo sozinho), o reset nem persistia na nuvem. Corrigido: preserva
   os campos de identidade, só reseta dados de jogo.
4. **Admin não é mais senha fixa.** Era `admin@local.teste` + senha `123456` na tela de login;
   removido. Agora é allowlist de e-mails Google reais (`ADMIN_EMAILS`), login continua aberto pra
   qualquer conta Google.
5. **Pagamento Pix**: nunca confiar só no webhook. `pixVerificar` reconsulta a API do Mercado
   Pago na hora (usada pelo botão "Já paguei, verificar", que também roda sozinho ao abrir um
   torneio com Pix pendente). Se não tiver `paymentId` salvo, cai pra busca por
   `external_reference` (`buscarPagamentoPorReferencia`) antes de desistir — cobre casos em que o
   registro se perdeu por algum bug de save.
6. **Link de árbitro convidado ("Apitar jogo")**: rota pública, mas protegida por um token
   aleatório por partida (`tokenApito`), gerado só sob demanda pelo dono/admin. Devolve e aceita
   só dados daquela UMA partida — nunca o torneio inteiro. A troca de lado (múltiplos de 6 pontos)
   e o cálculo de tempo do cronômetro precisam ficar espelhados entre `index.html`
   (`checkTrocaLado`) e `worker.ts` (mesma lógica duplicada lá), já que o app público não carrega
   o app inteiro.
7. **W.O. registra 18 a 0** pra equipe vencedora (não 1 a 0).
8. **Editando `index.html` com find-and-replace**: esse arquivo é enorme (~4500 linhas) e várias
   vezes uma edição com `old_str` curto (uma linha de declaração de variável, um `});` de
   fechamento) acabou "engolindo" essa linha porque o `new_str` não a reincluía — quebrando o
   boot inteiro do app (tela em branco). **Sempre revisar se o `old_str` inclui exatamente as
   linhas de abertura/fechamento necessárias**, e rodar `node --check` depois de qualquer edição
   nesse arquivo.

## Convenções

- Todo texto visível do app é em português (pt-BR).
- Cores: paleta inspirada na Heineken (verde `#008200`/`#205527`, vermelho `#FF2B00`), com
  variáveis CSS (`--ocean`, `--ocean-deep`, `--coral`, `--sand`, `--white`, `--ink`, `--muted`,
  `--heading`) que mudam de valor em `[data-theme="dark"]` pra dar suporte ao modo escuro — nunca
  usar cor fixa em componente novo, sempre `var(--algumacoisa)`, senão ele não acompanha o tema.
- Toasts (`showToast`) pra feedback rápido; `showLoading()`/`hideLoading()` (overlay com spinner)
  pra ações que demoram (rede).
- E-mails automáticos (aprovação, pagamento, novo torneio) são enviados via `enviarEmail()` no
  worker, usando as credenciais SMTP do Gmail.
