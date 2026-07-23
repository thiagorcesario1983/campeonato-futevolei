# App do Campeonato de Futevôlei

PWA para organizar campeonatos de futevôlei: sorteio de duplas, fase de grupos ou eliminação
simples, mata-mata, notificações por WhatsApp/Telegram, cobrança das diárias via Pix (Mercado
Pago), aprovação de torneios por um admin, link de árbitro convidado, modo claro/escuro, e
geração de imagem pra Stories do Instagram.

- **Site:** `https://ftv.supremoftv.com.br` (domínio customizado; o antigo
  `https://campeonato-futevolei.thiagobaptistella.workers.dev` continua existindo por baixo)
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
│   ├── _headers            ← força Cache-Control: no-store em /, /index.html e /service-worker.js
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
  usado pra listagem rápida), `telegram:{codigo}` (chat_id do Telegram por dupla/torneio) e
  `logs:index` (lista completa de eventos do log de atividade — login, torneio criado, sorteio de
  duplas, jogo finalizado —, capada nas 2000 entradas mais recentes, ver `LOGS_MAX`).

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
| `SESSION_SECRET` | qualquer string aleatória longa; assina o token de sessão emitido no login (ver item 20) — sem ela, login para de emitir token e nenhuma rota de dono/admin funciona |

⚠️ **`wrangler.jsonc` precisa ter `"keep_vars": true`** no nível raiz. Sem isso, o Wrangler trata
"nenhuma variável declarada no arquivo" como a configuração correta e apaga tudo que só existe no
painel a cada deploy — foi exatamente isso que apagava `ADMIN_EMAILS` sozinho. Não adicione essas
variáveis dentro de um bloco `"vars"` no `wrangler.jsonc` — elas devem existir só no painel.

Webhook do Telegram: se o domínio do site mudar, reconfigurar via
`https://api.telegram.org/bot{TOKEN}/setWebhook?url=https://SEU-DOMINIO/api/telegram-webhook`.

Webhook do Mercado Pago: painel Mercado Pago Developers → Webhooks → URL
`https://SEU-DOMINIO/api/pix-webhook`, evento `payments`.

### Checklist ao trocar de domínio (ou adicionar um domínio customizado)

Cada um desses pontos só vale pro domínio configurado nele — trocar/adicionar um domínio (ex:
sair do `*.workers.dev` pra um domínio próprio) não atualiza nenhum sozinho. Sem revisar os
quatro, o app pode continuar "funcionando" (o site abre normal) mas com login, bot do Telegram
e/ou confirmação de Pix quebrados silenciosamente:

1. **Login com Google** (senão dá erro no redirect, ver item 12 abaixo): Google Cloud Console →
   APIs e Serviços → Credenciais → o OAuth 2.0 Client ID usado no app (o mesmo salvo em
   Configurações → Client ID do Google) →
   - **Origens JavaScript autorizadas**: adicionar `https://SEU-DOMINIO`
   - **URIs de redirecionamento autorizados**: adicionar `https://SEU-DOMINIO/api/google-login-callback`
2. **Webhook do Telegram**: reconfigurar via `setWebhook` (URL acima).
3. **Webhook do Mercado Pago**: trocar a URL no painel (acima).
4. Pode manter as entradas do domínio antigo nos três painéis se ele ainda vai continuar
   acessível, ou remover se não for mais usar.

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
| `/api/log-list` | GET | só admin — lista o log de atividade completo |
| `/api/log-acesso` | POST | por e-mail — fallback do login popup (o fluxo redirect já loga direto em `googleLoginCallback`) |

Admin é decidido **só pelo servidor**, comparando o e-mail com `ADMIN_EMAILS` (`ehAdmin(email,
env)`). O front nunca guarda essa lista — recebe um `isAdmin: true/false` já resolvido via
`/api/config-get`.

## Decisões e bugs importantes (não repetir)

1. **`torneiosSave` reconstruía o registro inteiro a partir de um resumo leve (`meta`/index)** —
   isso apagava o campo `pagamento` (objeto completo do Pix) a cada salvamento normal do torneio,
   mesmo sem ninguém mexer nele. Corrigido: `torneiosSave` busca o registro completo existente e
   preserva `pagamento`, e faz um merge defensivo de `state.arbitragem` (preservando sempre o
   `tokenApito` do link de árbitro). **Qualquer rota nova que salve o torneio inteiro de uma vez
   precisa considerar esse mesmo risco.** Esse merge decide qual lado (servidor ou cliente) é
   "mais recente" comparando `arbitragem[matchId].atualizadoEm` (timestamp `Date.now()`, gravado
   em toda mutação — `arbIniciar`/`arbTempoTecnico`/`arbPonto`/`arbFinalizar`/`arbReabrir` no
   front e as mesmas ações em `apitoPost` no worker) — quem tem o timestamp maior vence, podendo
   inclusive regredir `finalizado` de volta pra `false`. **Não volte a comparar só pelo "rank" do
   status** (nao_iniciada < andamento/tecnico < finalizada, sem timestamp): foi assim que um
   "Reabrir jogo" acabava revertendo sozinho de volta pra "concluído" pouco depois — o merge via
   o "finalizada" antigo salvo no servidor como sempre mais avançado que o "reaberto" do cliente,
   mesmo o reabrir sendo a ação mais recente de verdade. Só cai de volta pro rank antigo (sem
   poder regredir `finalizado`) quando nenhum dos dois lados tem `atualizadoEm` (dado legado).
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
   torneio com Pix pendente e em background a cada 20s enquanto ficar pendente). Se não tiver
   `paymentId` salvo, cai pra busca por `external_reference` (`buscarPagamentoPorReferencia`)
   antes de desistir — cobre casos em que o registro se perdeu por algum bug de save.
   **O pagamento não depende da aprovação do admin, e vice-versa** — o Pix é gerado
   automaticamente assim que o torneio é criado (`torneiosSave`), já que datas e cupom são
   escolhidos pelo próprio organizador nesse momento (`gerarCobrancaPix`, reaproveitada também
   como rede de segurança dentro de `torneiosAprovar` e pelo botão manual "Gerar Pix"). A
   aprovação só bloqueia Pix se o torneio for recusado ou bloqueado depois — não exigir mais
   "aprovado" como pré-requisito. **E o inverso também vale**: assim que o pagamento é confirmado
   (`confirmarPagamentoAprovado`, chamada pelo webhook, pela verificação em background e pela
   manual), `aprovacaoStatus` avança sozinho de "pendente" pra "aprovado" — o torneio fica liberado
   pra uso sem precisar de um clique manual do admin na aba Aprovações. Por isso o e-mail de
   "pagamento confirmado" nunca deve reenviar o código Pix (o pagamento já aconteceu) — e o e-mail
   de aprovação (`torneiosAprovar`) só mostra o código Pix se `pagamento.status==="pendente"`,
   nunca se já estiver `"pago"`.
6. **Link de árbitro convidado ("Apitar jogo")**: rota pública, mas protegida por um token
   aleatório por partida (`tokenApito`), gerado só sob demanda pelo dono/admin. Devolve e aceita
   só dados daquela UMA partida — nunca o torneio inteiro. A troca de lado (múltiplos de 6 pontos)
   e o cálculo de tempo do cronômetro precisam ficar espelhados entre `index.html`
   (`checkTrocaLado`) e `worker.ts` (mesma lógica duplicada lá), já que o app público não carrega
   o app inteiro.
7. **W.O. registra 18 a 0** pra equipe vencedora (não 1 a 0).
8. **Fim de partida (18 pontos, vantagem de 2)**: `partidaAtingiuFim(pa, pb)` (`index.html`)
   sinaliza quando alguém chega a 18 pontos com pelo menos 2 de vantagem — se passar de 18 (ex:
   18x17), só considera "fim" quando a vantagem chegar a 2 (19x17, 20x18...), igual ao vôlei.
   Usada dentro do "Apitar jogo", tanto na versão completa do app (`arbPonto`) quanto no link
   público de árbitro convidado (`apitoPublicoAcao`). Só sinaliza a condição — nunca finaliza
   sozinha: sempre pede confirmação (`confirm()`) antes, e só chama `arbFinalizar`/ação
   `"finalizar"` se o usuário aceitar. Só verifica em quem *soma* ponto (delta > 0); uma correção
   pra baixo nunca dispara o convite.
9. **Editando `index.html` com find-and-replace**: esse arquivo é enorme (~4500 linhas) e várias
   vezes uma edição com `old_str` curto (uma linha de declaração de variável, um `});` de
   fechamento) acabou "engolindo" essa linha porque o `new_str` não a reincluía — quebrando o
   boot inteiro do app (tela em branco). **Sempre revisar se o `old_str` inclui exatamente as
   linhas de abertura/fechamento necessárias**, e rodar `node --check` depois de qualquer edição
   nesse arquivo.
10. **`torneiosAprovar` reconstruía o `meta` do índice sem incluir `cupomAplicado`** — mesma
    categoria de bug do item 1 (meta reconstruído do zero em vez de partir do registro completo),
    só que aqui ninguém tinha notado: assim que um torneio com cupom era aprovado/recusado/
    bloqueado, o `cupomAplicado` sumia do `torneios:index` pra sempre (o registro completo em
    `torneio:{id}` continuava com o campo certo, só o resumo é que perdia). Isso fazia o badge de
    cupom sumir da aba Aprovações depois da primeira decisão, e faria o relatório de uso de
    cupons (aba Cupons → Relatório de uso) parar de listar esses torneios. Corrigido incluindo
    `cupomAplicado` (e os novos `comissaoRepassada`/`comissaoRepassadaEm`, usados nesse mesmo
    relatório) explicitamente no `meta` de `torneiosAprovar`. **Reforça o aviso do item 1**: toda
    vez que uma rota reconstrói o objeto `meta` do índice em vez de fazer um update cirúrgico de
    campo, precisa copiar TODOS os campos que existem no registro completo, não só os que aquela
    rota especificamente usa.
11. **Deploy novo às vezes não aparecia pro usuário sem aba anônima/limpar cache.** Requisições pra
    `/`, `/index.html` e `/service-worker.js` batiam em `CF-Cache-Status: HIT` — a Cloudflare serve
    arquivo estático direto da borda quando o caminho combina com um asset, **sem passar pelo
    `fetch()` do Worker** (isso só muda com `run_worker_first: true`, que este projeto não usa).
    Por isso, tentar forçar `Cache-Control` de dentro de `src/worker.ts` (ex: interceptando o
    `return env.ASSETS.fetch(request)` final e reescrevendo o header) **não tem efeito nenhum** —
    esse código nunca roda pra essas rotas. Testado localmente com `wrangler dev`: sem `_headers`,
    `/` saía com `Cache-Control: public, max-age=0, must-revalidate` (cacheável, só revalida por
    ETag — na prática, span de propagação entre bordas da Cloudflare logo após um deploy podia
    devolver uma versão velha por alguns minutos). Corrigido com `public/_headers` (convenção
    herdada do Cloudflare Pages, suportada pelo binding `assets` do Workers), que a própria
    Cloudflare aplica na borda antes de decidir servir do cache — força `no-store` só no "shell"
    do PWA (HTML + Service Worker), mantendo o cache padrão pra `manifest.json`/ícones (mudam
    raramente). **Se precisar mexer em cache de assets estáticos de novo, mexa em `public/_headers`
    ou em `wrangler.jsonc` (`run_worker_first`), nunca no `fetch()` do Worker.**
12. **Login com Google usa `ux_mode:"redirect"`** (`initGoogleSignIn` em `index.html`), trocado do
    popup padrão porque o popup travava em alguns Safaris ao tentar "Usar outra conta" (ITP isola
    o popup de um jeito que a navegação interna não avança). Nesse modo, o Google faz um POST de
    volta pra `login_uri` (`/api/google-login-callback`, calculada como
    `${location.origin}/api/google-login-callback` — acompanha o domínio atual sozinha, não é fixa
    no código). Só que o Google **recusa esse POST com erro de redirect** se o domínio não estiver
    cadastrado no OAuth Client no Google Cloud Console (Origens JavaScript autorizadas + URIs de
    redirecionamento). Isso não é algo que o código resolve sozinho — é config do lado do Google,
    por fora do repositório. **Sempre que o domínio do site mudar (custom domain novo, por
    exemplo), ver o "Checklist ao trocar de domínio" acima antes de considerar o login quebrado.**
13. **"Trocar torneio" durante uma sincronização em voo corrompia o torneio real.** `syncTorneio()`
    agenda o envio (debounce 800ms) e só monta o payload/dispara o `fetch` quando o timer dispara —
    se o usuário clicasse em "Trocar torneio" (que reseta `state` pra `defaultState()` via
    `limparTorneioLocal()`) enquanto essa requisição ainda estava em voo, a resposta chegava depois
    e `enviarTorneioAgora` reatava o `cloudId` do torneio real de volta nesse `state` em branco (sem
    nome, sem pagamento) — parecia ter "criado um campeonato sem nome" e voltado a pedir Pix. Pior:
    se uma sincronização normal acontecesse depois com esse state corrompido ainda carregado, ela
    salvava `"Torneio sem nome"` por cima do nome real no servidor (`torneiosSave` usava
    `body.nome || "Torneio sem nome"` sem nunca preservar o nome já existente — mesma categoria dos
    itens 1/10, mas dessa vez no campo `nome`). Corrigido nos dois lados: `enviarTorneioAgora` só
    aplica a resposta se `state.cloudId` ainda for o mesmo que foi enviado (`payload.id`) — se o
    usuário já saiu do torneio nesse meio tempo, a resposta é ignorada; e `torneiosSave` agora cai
    pra `existing.nome` (não pro genérico) quando o payload chega sem nome, como rede de segurança
    extra. **Qualquer código que capture algo de `state` num callback assíncrono precisa considerar
    que `state` pode ter sido reatribuído (não só mutado) enquanto isso esperava.**
14. **Acesso compartilhado a um torneio (aba Configurações → "Usuários com acesso a este
    torneio")**: dono/admin pode adicionar e-mails de outras contas Google que passam a ter acesso
    operacional ao torneio (`usuariosPermitidos`, checado por `temAcessoTorneio` no worker — usado
    em `torneiosSave`, `torneiosGet`, `torneiosList` e `apitoCriarLink`). Decisão de produto
    deliberada: usuário compartilhado **nunca** pode excluir o torneio, gerar/verificar Pix, nem
    gerenciar essa própria lista (adicionar/remover outro usuário) — essas rotas
    (`torneiosDelete`, `pixCriar`, `pixVerificar`, `torneiosUsuarioAdicionar/Remover`) continuam
    checando só dono+admin, à parte de `temAcessoTorneio`. Cada adição/remoção gera uma entrada no
    log de atividade (`tipo: "permissao_usuario"`). Segue o mesmo padrão de atualização cirúrgica
    dos itens 1/10: `usuariosPermitidos` foi incluído tanto no `meta` de `torneiosSave` quanto no
    de `torneiosAprovar`, senão sumiria do `torneios:index` no primeiro save/aprovação depois de
    adicionar alguém (mesma classe de bug do `cupomAplicado`).
15. **Decisão de empate técnico antes do mata-mata (formato "grupos")**: quando duas ou mais duplas
    empatam de verdade nos 3 critérios de desempate (pontos, saldo, pontos pró) disputando a última
    vaga de classificação de um grupo, o app não decide sozinho (antes disso, a ordem ficava por
    conta do sort estável do JS, sem avisar ninguém) — mostra um card "⚖️ Decisão Desempate" no topo
    da aba Mata-mata (`gruposDesempateInfo`/`gruposDesempateInfoPorLetra`, mesmo raciocínio de
    `jaGarantidas`/`grupoEmpatado`/`vagas` já usado em `elimRepescagemInfo` pro formato
    "eliminacao") com seleção (rádio quando só falta 1 vaga, checkbox quando o empate envolve mais
    de uma) por grupo. Enquanto pendente ou não confirmado (`state.mataMataConfirmado`), nenhum
    consumidor do mata-mata considera os confrontos da 1ª rodada reais — `mataMataLiberadoParaJogar()`
    é a trava central, checada em `listarTodosOsJogos` (placar múltiplo), `elimMatchList`
    (notificações automáticas de WhatsApp/Telegram) e na geração da imagem de Stories, além do
    próprio `renderMataMata`. Só é liberado por um clique manual no botão "Gerar jogos do
    mata-mata". Mudar a escolha depois de já ter gerado os jogos reseta `state.bracket` (e a
    arbitragem do mata-mata/3º lugar) e exige gerar de novo — mas só é permitido enquanto nenhum
    jogo da 1ª rodada tiver começado (`mataMataIniciado()`, mesmo critério de "iniciado" usado no
    resto do app: placar parcial, finalizado ou arbitragem ativa); a partir daí os rádios/checkboxes
    ficam desabilitados. Torneios anteriores a essa funcionalidade com mata-mata já em andamento
    nunca são travados retroativamente (`mataMataLiberadoParaJogar` cai pra `mataMataIniciado()`
    quando não há confirmação registrada, em vez de esconder um jogo que já começou).
16. **`refreshTorneioAtual()` podia trazer de volta um placar antigo depois de "Reiniciar
    torneio" (ou qualquer save) se a rede caísse bem no instante do sync — inclusive depois de
    recarregar/reabrir a página, não só no polling periódico.** `syncTorneio()` agenda o envio
    (debounce 800ms) e só incrementa `enviosPendentes` quando o `fetch` realmente dispara — entre
    o clique e esse instante, a única proteção do polling de 5s era
    `Date.now()-ultimoSaveLocalEm < 4000`, que cobre o debounce mas não protege contra uma falha
    de rede nesse envio: se ele cair no `catch` (sem conexão no momento), o dado só é salvo na
    reserva local (`saveTorneioLocalFallback`) — o servidor nunca recebe o reset e continua com o
    estado antigo. Uma primeira correção guardou isso só em memória (flag zerada a cada reload),
    o que resolvia o polling mas não o caso relatado de verdade: reabrir/recarregar a página logo
    depois do reset, antes da rede voltar — nesse caso `refreshTorneioAtual(true)` no boot buscava
    o servidor incondicionalmente e trazia o placar antigo de volta (ex: o placar do jogo 1
    reaparecendo depois de reabrir o app). Corrigido com uma marca **persistida** em localStorage
    (`SYNC_PENDENTE_KEY`, setada em `save()` sempre que agenda um envio, limpa só quando
    `enviarTorneioAgora` confirma sucesso): enquanto ela existir, `refreshTorneioAtual` (usado
    tanto no boot quanto no polling) nunca busca do servidor — só tenta reenviar
    (`flushSyncTorneio()`) até a rede voltar e o servidor realmente confirmar. **Qualquer novo
    consumidor de `refreshTorneioAtual` (ou de outro polling/boot que leia do servidor) precisa
    considerar que o servidor pode estar mais desatualizado que o cliente, não só o contrário —
    e que isso pode durar além de um único reload.**
17. **"Reiniciar torneio" continuava trazendo de volta o placar do último jogo mesmo depois do
    fix do item 16 — a causa real era no servidor, não no cliente.** `torneiosSave` faz um merge
    defensivo de `state.arbitragem` pensado pra preservar progresso de outro dispositivo que este
    cliente ainda não viu (ex: um árbitro convidado apitando em paralelo): quando o payload não
    tem arbitragem pra um `matchId` que o servidor conhece (`!arbCliente`), ele resgatava a
    arbitragem antiga do servidor de volta pro payload — inclusive reescrevendo `pa`/`pb`/
    `finalizado` do jogo. Só que `resetTudo()` também zera `state.arbitragem` de propósito (fica
    `{}`), e esse merge não conseguia distinguir "cliente ainda não viu essa arbitragem" de
    "cliente acabou de resetar tudo" — sempre caía no primeiro caso e resgatava o resultado
    antigo de volta, **mesmo num save que teve sucesso total**, sem nenhuma falha de rede
    envolvida (por isso o fix do item 16, que só cobre falha de sync, não resolvia sozinho).
    Corrigido com uma marca `resetadoEm` (timestamp `Date.now()`, setada em `resetTudo()` junto
    com o resto do reset): o merge agora só resgata a arbitragem antiga do servidor quando o
    `atualizadoEm` dela for mais recente que esse `resetadoEm` — ou seja, só quando for uma
    atualização de verdade concorrente (posterior ao reset), nunca um resquício de antes dele.
    **Qualquer novo caminho que zere `state.arbitragem` no cliente (não só `resetTudo`) precisa
    lembrar de marcar `resetadoEm` também, senão esse merge do servidor volta a resgatar o que
    acabou de ser zerado.**
18. **Link de árbitro convidado (e cupom de desconto) bloqueava/expirava até 3h antes da hora
    certa, por causa de fuso horário.** `torneioExpirado` (usada pelo link de árbitro e pelo
    modo somente-leitura de torneio encerrado) e `checarValidadeCupom` comparavam a data com
    `new Date().toISOString().slice(0,10)` — mas o Worker roda em UTC, e o app é só pt-BR/Brasil
    (UTC-3). Entre 21h e 23h59 no horário de Brasília, o UTC já tinha virado o dia seguinte, então
    um torneio configurado até "hoje" (ou um cupom válido até "hoje") já aparecia
    encerrado/expirado horas antes da meia-noite de verdade local. Corrigido com
    `hojeBrasilISO()` (`Intl.DateTimeFormat("en-CA", {timeZone:"America/Sao_Paulo"})`) no lugar
    do `toISOString()` cru. **Qualquer nova comparação de "hoje" no worker.ts precisa usar
    `hojeBrasilISO()`, nunca `new Date().toISOString()` direto — o runtime não tem fuso local
    nenhum, é sempre UTC.**
19. **Log de atividade registrava "Jogo finalizado: ? 18 x 14 ?" pros jogos do mata-mata/3º
    lugar — "?" no lugar do nome das duplas.** `registrarLogs` (dentro de `torneiosSave`, no
    worker) monta a descrição direto de `m.a`/`m.b` do objeto do jogo recém-finalizado. Isso
    funciona pra grupos/eliminação (`state.groupMatches`/`state.elimRodadas[].matches` sempre têm
    `.a`/`.b` gravados desde o sorteio), mas os jogos de `state.bracket` (mata-mata) **nunca**
    guardam nome no próprio objeto — quem joga cada confronto é resolvido dinamicamente só no
    cliente (`bracketTeamsForRound`/`gruposClassificadosFinal`), já que depende de standings e de
    uma eventual decisão de empate técnico (ver item 15) ainda podendo mudar. Sem `.a`/`.b`, o
    worker caía no fallback `m.a || "?"`. Corrigido anotando `.a`/`.b` nos objetos de
    `state.bracket`/`state.terceiro` no cliente (`anotarNomesBracket()`, chamada em
    `montarPayloadTorneio()` antes de todo envio) — só um espelho pro log conseguir mostrar o
    nome; nada no cliente lê esses campos de volta (sempre recebe os nomes já resolvidos como
    parâmetro à parte), então não há risco de conflito com a lógica dinâmica existente.
20. **Qualquer requisição direta podia se passar por qualquer e-mail — inclusive de outro
    organizador — e ler/editar/excluir o torneio dele.** Descoberto depois de um torneio
    aparecer criado sozinho, atribuído a um e-mail que ninguém logou naquele momento. Causa:
    todas as rotas de dono/admin (`torneiosSave`, `torneiosList`, `torneiosGet`,
    `torneiosDelete`, `pixCriar`, `pixVerificar`, `apitoCriarLink`, `inscricaoCriarLink`,
    `torneiosUsuarioAdicionar/Remover`, `torneiosComissao`, `torneiosAprovar`, `configSet`,
    `logList`, cupons admin) só liam um campo `email`/`ownerEmail`/`adminEmail` solto do
    corpo/query e confiavam nele — nunca verificavam se quem mandou aquele POST realmente
    tinha passado pelo login do Google com esse e-mail. **O login em si nunca verifica a
    assinatura do JWT do Google** (`googleLoginCallback` só decodifica o `credential`, decisão
    antiga e deliberada — só o CSRF do fluxo redirect protege contra forjar esse POST
    específico de fora) — o que faltava era a parte de DEPOIS do login: nada amarrava as
    chamadas de API seguintes a esse login de verdade. Corrigido com um token de sessão HMAC-
    SHA256 (`SESSION_SECRET`, novo secret): `mintSessionToken`/`verificarSessionToken`/
    `emailAutenticado` em `worker.ts` — emitido só em `googleLoginCallback` (a única rota com
    proteção CSRF real) e exigido via header `Authorization: Bearer` em toda rota de dono/
    admin, que agora extrai o e-mail do token verificado em vez de confiar num campo solto
    (`solicitanteEmail = await emailAutenticado(request, env)`). `torneiosSave` também passou a
    setar `ownerEmail` de um torneio novo a partir desse e-mail verificado, nunca mais do
    `body.ownerEmail` do cliente. No front, `auth.sessionToken` é gravado no login (o próprio
    `googleLoginCallback` já escreve ele no `localStorage` junto com email/nome/foto) e todo
    fetch pra rota de dono/admin passa a usar `apiFetch()` (wrapper que gruda o header via
    `authHeaders()` e, num 401, chama `sessaoExpirada()` — desloga só a conta, preserva
    torneio/estado local, ao contrário de `logout()`). **Os links públicos (apito, inscrição)
    não usam nada disso** — são um mecanismo à parte, token aleatório por recurso
    (`tokenApito`/`inscricaoLink.token`), sem noção de login nenhuma; essa correção não mexe
    neles. **Ressalva conhecida:** o raro fallback de popup do Google Identity Services
    (`handleGoogleCredential`, usado só quando o navegador não segue o fluxo redirect padrão)
    não emite `sessionToken` — sessões vindas daí tomam 401 na primeira ação autenticada e
    precisam logar de novo pelo fluxo redirect. Aceito porque o próprio código já documentava
    esse popup como fallback raro, e a alternativa (verificar a assinatura do JWT do Google via
    JWKS pra também cobrir esse caminho) é bem mais complexa pro ganho marginal. **Qualquer rota
    nova que precise saber quem está autenticado deve usar `emailAutenticado(request, env)`,
    nunca ler `email`/`ownerEmail` direto do corpo ou da query.**
21. **Corrida de concorrência na última vaga do link de inscrição**: com o KV não-transacional,
    duas inscrições simultâneas bem na última vaga podem, em tese, passar as duas pela checagem
    de `inscricaoVagasOcupadas` e resultar em mais duplas do que o limite configurado. Aceito
    como risco residual (raro, baixo volume) — fechar 100% exigiria um mecanismo atômico de
    verdade (Durable Objects em vez de KV), complexidade desproporcional pro tamanho desse app.
    O que foi implementado (mitiga o caso mais comum, que é bem mais provável que a corrida em
    si): um **Cron Trigger** (`triggers.crons` em `wrangler.jsonc`, roda de hora em hora →
    `scheduled()` no `worker.ts` → `expirarInscricoesPendentes`) que bloqueia sozinha (`status:
    "bloqueada"`, nunca hard-delete — mesma regra de sempre pra `origem:"inscricao"`) toda dupla
    inscrita pelo link público que ficou "pendente" (Pix não pago, nem aprovação manual) por
    mais de 24h (`INSCRICAO_EXPIRACAO_MS`), liberando a vaga pro próximo interessado. Gera log
    (`inscricao_expirada`, com os dados completos dos 2 jogadores) e manda e-mail pro
    organizador avisando. **Escopado só a `origem === "inscricao"`** — dupla adicionada
    manualmente pelo organizador (que também nasce "pendente") nunca expira sozinha, já que só
    ele decide quando aprovar essa. Por nascer como "bloqueada" (não um status novo), a dupla
    continua reativável a qualquer momento pelo botão "Aprovar" normal, sem código extra.
    **Se algum dia precisar rodar esse worker localmente com o cron**: `wrangler dev
    --test-scheduled` expõe `/__scheduled` pra disparar manualmente sem esperar a hora virar.

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
