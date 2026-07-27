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

- `duplas`: `[{nome, tel1, tel2, nomeDefault, cabecaDeChave}]` — `cabecaDeChave` (booleano, opcional)
  só é considerado no sorteio do formato "grupos" (ver item 22); ignorado em "eliminacao"
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
22. **Cabeça de chave, só no formato "grupos"** (`d.cabecaDeChave`, booleano por dupla, editável
    na aba Duplas antes do sorteio): opcional — com 0 marcadas, `sortear()` sorteia 100%
    aleatório, exatamente como sempre foi. Só quando a quantidade marcada bater **exatamente**
    com `state.numGrupos` (uma por grupo — checado em `configuracaoValida`, bloqueando o botão
    "Sortear" enquanto não bater) é que o sorteio muda: separa as cabeças de chave das demais
    duplas, embaralha cada lista **separadamente**, distribui 1 cabeça de chave por grupo (sorteada
    aleatoriamente entre os grupos, não em ordem fixa) e só depois preenche o resto dos grupos
    com as demais duplas embaralhadas — garantindo que nenhum grupo fique com 2 cabeças de chave
    nem sem nenhuma. Completamente ignorado no formato "eliminacao" (não existe a noção de
    "grupo" ali, então a checkbox nem aparece nessa modalidade).
23. **Log de aprovação/bloqueio/remoção manual de dupla** (`dupla_aprovada`, `dupla_bloqueada`,
    `dupla_removida`, detectados em `torneiosSave`): mesma técnica de comparar "antes" (
    `existingFull.state.duplas`) com "depois", mas aqui o "depois" **não pode ser**
    `body.state.duplas` já mesclado — precisa ser um snapshot do que o cliente mandou de
    verdade, capturado logo no início da função, **antes** do merge defensivo de duplas rodar
    (`duplasClienteOriginalPorId`). Motivo: o merge pode resgatar um `status`/`ativacaoVia` mais
    novo vindo do próprio servidor (ex: outro dispositivo aprovando em paralelo, ou o cron de
    expiração do item 21 bloqueando uma inscrição) *dentro* de `body.state.duplas` antes da
    comparação — se a comparação usasse esse valor já mesclado, atribuiria a ação a quem só
    estava sincronizando outra coisa nesta requisição, e/ou duplicaria um log que outro caminho
    (`inscricao_paga`, `inscricao_expirada`) já registrou. Com o snapshot pré-merge, só loga
    quando a transição realmente veio do payload que ESSE cliente montou (ex: clicou em
    "Aprovar"/"Bloquear"/🗑️ na própria tela). `dupla_aprovada` exige especificamente
    `ativacaoVia==="manual"` (não dispara pra ativação automática via Pix, já coberta por
    `inscricao_paga`); `dupla_removida` é restrito a `origem==="manual"` (duplas de inscrição
    nunca são removidas de verdade, só bloqueadas — ver item 14).
24. **Patrocinadores** (`state.patrocinadores: [{id, nome, logo}]`, `logo` em data URL PNG,
    configurado na aba Configurações): aparecem no Placar de TV (faixa fixa na base da tela,
    `.tv-sponsors`) e no rodapé da imagem de Stories (`drawSponsorsSection`). Só front-end —
    nada no worker.ts, já que é um campo de escritor único (organizador), sem concorrência,
    trafega dentro do `state` normal do torneio como qualquer outro campo. No Story, a logo é
    carregada de forma assíncrona (`getSponsorImage`, mesmo padrão de `getStoryHeaderImage`
    pro banner de topo): a primeira chamada de `drawSponsorsSection` não desenha nada ainda
    (retorna cedo se a imagem não carregou), e o próprio `onload` da imagem manda redesenhar o
    canvas inteiro (`drawStoryCanvas()`) — como esse redesenho roda a mesma lógica de
    medir-e-redimensionar do zero, a altura final do Story já sai contando com a faixa de
    patrocinadores, sem precisar de nenhum código extra pra isso.
    **Bug corrigido**: o fluxo original pedia o nome do patrocinador via `prompt()` nativo do
    navegador — se isso fosse cancelado ou bloqueado silenciosamente (comum em PWA instalado/
    navegador in-app), o upload abortava sem nenhum aviso (`if(!nome){ e.target.value=""; return; }`),
    dando a impressão de que a logo "sumia" depois de escolhida. Substituído por um formulário
    inline dentro do próprio card (`novoPatrocinadorLogo`/`editandoPatrocinadorId`, mesmo padrão
    de "criar novo X" usado em Circuitos/Cupons/Torneios) — a logo é processada e mostrada em
    preview imediatamente, o nome é digitado num `<input>` normal, e só o clique em "Salvar"
    grava em `state.patrocinadores`. O mesmo formulário também virou o fluxo de edição (botão
    ✏️ ao lado do 🗑️ em cada patrocinador já cadastrado): pré-preenche o nome, permite trocar só
    a imagem (mantendo o nome) ou só o nome (mantendo a imagem já salva).
25. **CPF opcional em `jogador1`/`jogador2`** (`{nomeCompleto, tel, email, cpf}`, editável tanto
    no formulário manual da aba Duplas quanto no formulário de inscrição pública): existe hoje só
    pra dar suporte ao ranking por circuito (item 26) — precisa de uma chave estável de
    identidade de jogador entre torneios diferentes, e telefone pode mudar (perderia o vínculo).
    Guardado no `state` **já com a máscara visual** (`000.000.000-00`, via `formatarCPF()`),
    igual ao `tel` — quem consome o valor (validação, futura agregação do ranking) sempre remove
    a formatação antes de comparar. Só é validado (dígito verificador mod-11, `validarCPF` em
    `worker.ts`) no caminho público de inscrição (`inscricaoValidarJogador`) — a mesma assimetria
    que já existe pra tel/e-mail: entrada manual do organizador continua sem validação forçada.
    Campo totalmente opcional em ambos os caminhos; ausência de CPF nunca bloqueia nada, só
    impede aquele jogador de agregar pontos entre torneios diferentes no ranking.
26. **Ranking por circuito** (`Circuito` em `worker.ts`, KV `circuitos:index` — lista completa
    numa chave só, mesmo padrão leve de Cupons, sem par índice+detalhe): agrupa torneios
    escolhidos manualmente pelo organizador (não automático por "mesmo dono") e soma pontos por
    colocação final de cada JOGADOR (não dupla — chave de agregação é o CPF, ver item 25, já que
    jogadores trocam de parceiro entre torneios de um mesmo circuito).
    - **Decisão de arquitetura mais importante**: o servidor nunca re-deriva quem é campeão/
      vice/3º/4º lugar. Essa resolução já existe no cliente (`champion()`/`semifinalLosers()`/
      `terceiroWinner()`, historicamente cheia de bugs sutis de bye/empate técnico — itens 2 e
      15) e é reaproveitada tal como está (`montarColocacoesCircuito()`); o cliente só faz um
      POST do resultado já resolvido (`/api/circuito-resultado-torneio`), e o servidor apenas
      valida o formato e guarda. Reimplementar a resolução de chaveamento no worker duplicaria
      o mesmo risco histórico.
    - **Pontos não são gravados no resultado** — só a posição (1/2/3/4/"participacao"). A
      multiplicação pela tabela de pontos (`pontuacaoTabela`, editável a qualquer momento)
      acontece ao vivo dentro de `circuitoRanking()` (rota pública), então mudar a tabela
      recalcula sozinho todo o histórico, sem precisar de um botão "recalcular".
    - **CPF é o único critério de agregação** — entradas sem CPF aparecem no resultado daquele
      torneio específico mas nunca somam com outro torneio. CPF nunca é devolvido completo pela
      rota pública (`mascararCPF`), só como chave de agregação interna.
    - **Ponto de entrada é uma variável de tela própria** (`telaCircuitos`, dentro da própria
      `renderTorneiosScreen()` — que, como as outras telas soltas, só é renderizada quando
      `!state.cloudId`, fora de um torneio aberto; entrar num torneio e sair de novo ("Trocar
      torneio") não zera `telaCircuitos` sozinho, mesmo comportamento já existente de `telaAdmin`).
      Originalmente ficou fora do mecanismo `telaAdmin`/`nav-admin` (Cupons/Aprovações/Config/Log,
      gated por `ehAdmin()`) porque a ideia era deixar disponível pra QUALQUER organizador — **essa
      decisão foi revertida no item 34**: circuito hoje é admin-only, `telaCircuitos` só é lido
      quando `ehAdmin()` também é true (o botão "🏆 Circuitos" nem aparece pra quem não é admin).
    - **`torneioIds` do circuito tem um campo espelho em cada torneio** (`torneio.circuitoIds`,
      top-level no registro completo — ao lado de `pagamento`, não dentro de `state` —, escrito
      só por `circuito-atualizar`, nunca pelo cliente): `torneiosSave` sempre preserva esse campo
      a partir do registro existente, ignorando o que vier em `body.state.circuitoIds`, mesmo
      padrão de proteção já usado pra `pagamento` (item 1). Ao linkar um torneio a um circuito,
      o servidor exige que o solicitante tenha `temAcessoTorneio` daquele torneio específico —
      sem essa checagem, o dono de um circuito poderia colar o id de um torneio de outro
      organizador e vazar nomes/CPFs das duplas dele no ranking público.
    - Envio automático (`verificarEnvioResultadoCircuito`) dispara sempre que
      `torneioTotalmenteFinalizado()` (item 25) for true e o torneio estiver vinculado a algum
      circuito — fire-and-forget, idempotente do lado do servidor (sempre sobrescreve o
      resultado daquele torneio), com uma marca local (`circuitoResultadoEnviadoEm`) só pra não
      bater na rede sem necessidade. Chamada em três pontos, não só em `save()`: **também em
      `abrirTorneioComDados()` e em `refreshTorneioAtual()`** — sem isso, um torneio já concluído
      ANTES de existir o circuito (ou vinculado a um depois de pronto, pela tela Circuitos) só
      entraria no ranking se alguém editasse alguma coisa nele depois de vinculado (a edição é
      o que dispara `save()`); só abrir esse torneio de novo não bastava, já que
      `abrirTorneioComDados`/`refreshTorneioAtual` só atualizam `state` e chamam `render()`, sem
      passar por `save()`. Reforça: **qualquer novo fluxo que recarregue `state` a partir do
      servidor (não só edições feitas pelo usuário) precisa considerar se `verificarEnvioResultadoCircuito`
      também deveria rodar ali**, senão um resultado "atrasado" (torneio antigo vinculado depois)
      fica esperando uma edição manual que pode nunca acontecer.
    - **Vincular um torneio já concluído rankeia na hora, sem precisar reabri-lo** — mesmo com o
      fallback acima, o organizador não deveria precisar entrar de novo no torneio só pra "ativar"
      o cálculo. `enviarResultadoRetroativoParaTorneio(torneioId)` roda assim que a caixinha de um
      torneio é marcada na tela Circuitos (nunca ao desmarcar): busca o `state` completo desse
      torneio via `/api/torneios-get`, troca a variável global `state` por essa cópia só
      temporariamente (pra reaproveitar `champion()`/`montarColocacoesCircuito()`, que sempre
      leem `state` direto — nunca recebem parâmetro, ver decisão de arquitetura acima) e devolve o
      `state` original logo em seguida. Essa troca é segura porque é 100% síncrona (nenhum
      `await` entre trocar e devolver) — o JS nunca cede o controle no meio pra outro código
      (timer, clique, `render()` de outra tela) enxergar esse `state` temporário. **Se algum dia
      essa troca precisar ganhar uma etapa assíncrona no meio, pare e repense** — é exatamente o
      tipo de mudança que introduziria uma condição de corrida.
27. **Menu lateral recolhível** (substituiu a barra de abas inferior antiga): `#nav-torneio` e
    `#nav-admin` (os mesmos elementos/botões de sempre, `data-tab`/`data-tela-admin` e toda a
    lógica de `render()`/`bindEvents()` que os controla — nada mudou aí) só foram REALOCADOS pra
    dentro de um novo `<aside id="sidebar">`, com CSS reescrito de barra horizontal pra lista
    vertical. Isso foi deliberado: qualquer mudança de comportamento (mostrar/esconder,
    `.active`, badge do mata-mata) continua funcionando sem tocar em JS de navegação.
    - **Cores do menu são fixas escuras, não seguem `--theme`** — única exceção deliberada à
      regra de "sempre `var(--algumacoisa)`" logo abaixo: o pedido era um menu com visual de
      "control room" (fundo quase preto + destaque verde neon), igual em modo claro ou escuro
      do resto do app. Variáveis próprias (`--sidebar-bg`, `--sidebar-bg-hover`,
      `--sidebar-bg-active`, `--sidebar-border`, `--sidebar-text`, `--sidebar-text-muted`,
      `--sidebar-accent`) ficam só no `:root` (nunca redefinidas em `[data-theme="dark"]`) —
      `--sidebar-accent` reaproveita o mesmo verde neon (`#2ECC58`) já usado como `--ocean` no
      modo escuro do app, só pra manter identidade visual entre os dois.
    - **Dois comportamentos por breakpoint, controlados pela MESMA função** (`alternarSidebar()`,
      chamada tanto pelo hambúrguer no header quanto pela setinha dentro do próprio menu):
      abaixo de 901px (`ehDesktopViewport()`, via `matchMedia`) é uma gaveta (`.mobile-open`,
      `position:fixed` fora da tela por padrão, desliza por cima do conteúdo com
      `.sidebar-backdrop` escurecendo atrás — fecha sozinha ao clicar num item de navegação
      via `fecharSidebarMobile()`, ou ao clicar no backdrop); a partir de 901px vira coluna fixa
      (`position:sticky`, sempre visível, empurra o conteúdo — `.app` passa a `flex-direction:row`)
      e a mesma ação só encolhe pra um trilho de ícones (`.desktop-collapsed`, 76px, esconde
      `.lbl`/`.sidebar-brand-text`) em vez de esconder de vez. **Qualquer novo item de menu deve
      ir dentro de `#nav-torneio`/`#nav-admin` como os demais** (`<button>` com `<svg>` +
      `<span class="lbl">`) — não precisa de CSS novo, o estilo já é genérico por `nav.tabbar`.
28. **Laranja/âmbar removido do app inteiro** (pedido explícito — o app deve seguir só a paleta
    verde/vermelho já estabelecida, sem tons quentes de laranja/dourado/marrom-claro em lugar
    nenhum). Dois novos pares de variáveis, em `:root`/`[data-theme="dark"]` junto dos outros:
    - `--pending-bg`/`--pending-text`: verde bem mais opaco/dessaturado que `--ocean`/`--grass`,
      pra selos de "pendente"/"aguardando" (aprovação, pagamento, comissão, dupla, empate técnico
      no Fluxo de Jogos) não parecerem "aprovado" de verdade enquanto ainda esperam alguma coisa.
      Substituiu o par âmbar/pêssego antigo (`#FCEFD8`/`#9A6B1E` e variantes) usado em
      `badgeAprovacao`, `badgePagamento`, `badgeStatusGeral`, `badgeStatusDupla`, `badgeCupom`,
      `COR_TIPO_LOG.duplas_sorteadas` e no badge "AGUARDANDO DECISÃO" do Fluxo de Jogos.
    - `--coral-bg`: fundo suave pareado com `--coral` (badges "ao vivo"/"em andamento" — `.tg-
      status.pending`, `.status-pill.andamento`, `.live-score-badge`) — antes usava o mesmo
      pêssego alaranjado (`#FDF1E7`) só que combinado com texto coral, o que também lia como
      laranja visualmente.
    - `.champion-banner` (banner de campeão, Resumo/Mata-mata/Fluxo de Jogos) usava gradiente
      coral→laranja-queimado (`#C94A16`) quando renderizado SEM override inline — corrigido pro
      mesmo gradiente verde (`--grass`→`--ocean-deep`) que uma das telas já usava via inline
      style (removido o inline agora redundante, os dois lugares usam a mesma classe).
    - Indicador de "1 derrota" na lista de status da eliminação (`renderSituacaoEliminacaoLista`)
      e o passo "🏆 Campeão" no Fluxo de Jogos também usavam tons dourado/laranja isolados —
      viraram `var(--pending-text)`/`var(--grass)` respectivamente.
    - Borda de `.card`/`.group-card` (creme fixo `#EDE7D8`, não acompanhava `[data-theme="dark"]`)
      virou `var(--sand-dark)` — corrige de quebra um card com borda clara demais no modo escuro.
    - **Fora do escopo, de propósito**: Placar de TV e a imagem gerada pro Stories (```renderStory```/
      `drawGroupsSection`/`drawTeamBar`/`drawBracket`, que usam `GOLD`/`GOLD_BG` no canvas) têm
      identidade visual própria pensada pra serem vistas de longe/postadas — não fazem parte
      desse pente-fino, mantidos exatamente como estavam.
29. **App sempre no modo escuro** (pedido explícito — visual "control room" fiel a uma
    referência externa, sem alternador claro/escuro): o script no `<head>` seta
    `data-theme="dark"` incondicionalmente (antes lia `localStorage`/`prefers-color-scheme`); o
    botão `#btn-theme-icon` e as funções `aplicarTema`/`temaAtual`/`alternarTema` foram
    removidos por completo (não é código morto de propósito — o app não tem mais noção de "modo
    claro" alcançável pelo usuário). O bloco `:root` (claro) continua existindo no CSS só como
    fallback defensivo caso o atributo `data-theme` não seja aplicado por algum motivo — na
    prática, inatingível. As variáveis do tema escuro (`--sand`, `--white`, `--ocean`, `--ink`,
    `--muted`, `--heading` etc., em `[data-theme="dark"]`) foram alinhadas pra bater exatamente
    com as do menu lateral (`--sidebar-bg`, `--sidebar-accent` etc. — mesmo preto de fundo,
    mesmo verde vívido de destaque), então hoje é uma paleta única — antes eram dois tons de
    escuro/verde sutilmente diferentes (um pro menu, outro pro resto do app).
30. **Labels em caixa alta no app inteiro** (mesmo tratamento tipográfico já usado no menu
    lateral e nos `.stat .lbl`/`.jogador-group label`, que já eram assim): todo `<label>` de
    campo de formulário (Configurações, Aprovações, Cupons, Circuitos, Duplas, inscrição
    pública, apito público) ganhou `text-transform:uppercase;letter-spacing:.04em;` — antes só
    alguns lugares seguiam essa convenção, a maioria (principalmente os "criar novo X" e o card
    de Configurações) usava texto normal. **Efeito colateral aceito**: como alguns botões de
    upload de arquivo são `<label class="btn ...">` dentro do mesmo contêiner que essa regra
    mira (`.tg-settings label`), o texto desses botões (ex: "Escolher imagem") também virou
    caixa alta — mantido assim de propósito, o resultado ficou consistente com o resto do
    visual "control room" em vez de destoar.
31. **Header fixo no topo** (`header{position:sticky;top:0;z-index:20;}`, era `position:relative`):
    acompanha o menu lateral, que já era fixo (`position:fixed` na gaveta mobile,
    `position:sticky` na coluna do desktop) — antes só o menu ficava fixo, o cabeçalho (banner
    verde + nome do torneio + "Trocar torneio") rolava junto com o conteúdo. `#torneio-bar` (e os
    banners de "somente leitura"/"pré-liberado" que ele injeta) fica dentro do próprio `<header>`
    no HTML, então já fica fixo de graça, sem precisar de nenhuma mudança adicional.
    `position:sticky` (em vez de `fixed`) porque continua funcionando sem precisar compensar a
    altura do header com padding manual em nenhum lugar — quem rola é sempre `body`/`html` (o
    app não usa scroll interno em `.app`/`main`), então basta isso pra "grudar" no topo.
32. **Marcar várias caixinhas em "Torneios neste circuito" só processava uma** (bug reportado
    com print da tela). Causa: cada mudança de caixinha (`data-circuito-torneio`) disparava seu
    próprio `atualizarCircuito()` de forma independente e imediata — como o servidor
    (`circuitoAtualizar`) substitui `torneioIds` por inteiro (sem merge, ver item 26), duas ou
    mais chamadas concorrentes (cada uma com um snapshot diferente de "quais estão marcadas
    agora no DOM") competiam entre si, e a última resposta a chegar vencia — podendo derrubar
    seleções feitas entre o clique e a resposta chegar. Piorava porque `atualizarCircuito()`
    chama `render()` ao concluir, recriando os elementos de checkbox (e seus listeners) no meio
    da sequência de cliques do usuário. Corrigido trocando o modelo de "salva a cada clique" por
    um botão explícito **"💾 Salvar vínculos"**: as caixinhas agora só marcam/desmarcam no DOM,
    sem nenhuma chamada de rede; o clique no botão lê o estado final uma única vez, calcula o
    diff contra `circuito.torneioIds` anterior (só quem foi **adicionado** agora entra na fila de
    processamento — quem já estava vinculado não é reprocessado à toa) e manda uma única
    requisição pra `atualizarCircuito`. **Mesma categoria de risco de outros pontos do app que
    leem "o estado atual do DOM" de forma assíncrona** (ver itens 1/13/16/17): sempre ler o
    snapshot final uma vez só, nunca por evento individual quando o resultado de cada evento vai
    sobrescrever o mesmo recurso compartilhado no servidor.
    - **Auditoria do processamento**: cada torneio na lista agora mostra um status claro —
      não vinculado / vinculado sem processar ainda / processado com sucesso (com timestamp) /
      erro / ainda não concluído (com a mensagem exata) — usando um novo estado só de memória
      `statusProcessamentoCircuito` (chave = torneioId), preenchido tanto pelo fluxo automático
      quanto pelos botões manuais por linha (**"⚙️ Processar agora"**, **"🔁 Tentar novamente"**,
      **"🔍 Verificar novamente"**, **"↻ Recalcular"** — todos chamam a mesma função, só mudam de
      rótulo conforme o estado atual). Pra viabilizar isso sem duplicar lógica,
      `enviarResultadoRetroativoParaTorneio` foi separada em duas: `calcularResultadoRetroativo`
      (só calcula, sem enviar nada — dry-run) e `enviarResultadoRetroativoParaTorneio` (chama a
      primeira e só faz o POST se `status==="pronto"`); as duas agora **sempre devolvem um
      status** (`{status:"sucesso"|"erro"|"nao_concluido"|"pronto", mensagem?, colocacoes?}`) em
      vez de silenciosamente não fazer nada — antes, qualquer falha (torneio não encontrado, rede
      fora, torneio ainda não terminou) só aparecia num `console.error`, sem nenhum jeito de saber
      pela UI que algo não tinha sido processado.
    - **Link "🔍 Ver dados"** por torneio já processado expande um painel inline mostrando cada
      `colocacoes[]` gravado de verdade em `circuito.resultados[torneioId]` (posição rotulada via
      `rotuloPosicaoCircuito()`, nome do jogador, CPF mascarado com `formatarCPF()` ou "sem CPF")
      — usa o dado já salvo no servidor (não um cache local da última tentativa), então sempre
      reflete o que está realmente gravado, útil pra auditar se o ranking está somando os
      jogadores certos.
33. **Um torneio só pode pertencer a UM circuito por vez** (pedido explícito, pra evitar o mesmo
    torneio somar pontos em dois rankings diferentes). Antes disso nada impedia vincular o mesmo
    torneio a vários circuitos (`Circuito.torneioIds` sempre foi um array por torneio também —
    `torneio.circuitoIds`, espelho descrito no item 26 — sem limite). Regra aplicada nos dois
    lados:
    - **Servidor** (`circuitoAtualizar`, `src/worker.ts`): ao processar uma adição em
      `body.torneioIds`, se o espelho `torneio.circuitoIds` já apontar pra outro circuito
      (`cid !== circuito.id`), a adição é recusada (o torneio nem entra em
      `circuito.torneioIds`) e volta no array `rejeitadosJaVinculados: [{torneioId, circuitoId}]`
      da resposta — nunca falha a requisição inteira (os outros torneios do mesmo payload que
      não tiverem conflito continuam sendo processados normalmente). Isso é defesa em
      profundidade: o cenário real que motivaria isso é duas abas/sessões tentando vincular o
      mesmo torneio a circuitos diferentes ao mesmo tempo — o front já impede isso na UI (abaixo),
      mas o servidor não pode confiar só nisso.
    - **Front** (`renderCircuitoDetalheScreen`): antes de renderizar a lista de torneios,
      monta um mapa torneioId → circuito (varrendo `circuitosList` inteiro, procurando em qual
      OUTRO circuito aquele torneioId já aparece em `torneioIds`). Se o torneio já pertence a
      outro circuito (e não ao que está aberto agora), a caixinha nasce `disabled` e o texto de
      status vira `🔗 Vinculado ao circuito "{nome}"` no lugar do fluxo normal — inclusive
      ficando de fora da leitura final feita pelo botão "Salvar vínculos"
      (`:checked:not(:disabled)`), então nem é possível tentar re-selecioná-lo por essa tela.
    - Também aproveitado pra mostrar o **código do torneio** (`#{codigo}`, mesmo formato já usado
      em Aprovações) ao lado do nome na lista — várias duplas de torneios podem ter nomes
      parecidos, o código serve de identificador inequívoco pra saber qual torneio é qual.
    - **Pontos no painel de auditoria**: o "Ver dados" (item 32) mostrava só a posição/jogador/CPF
      — sem o valor em pontos daquela colocação, forçava o organizador a fazer a conta de cabeça
      contra a tabela de pontos. Novo helper `pontosPorPosicaoCircuito(tabela, posicao)` no front
      (espelha exatamente a mesma lógica de `circuitoRanking()` no worker) calcula ao vivo na
      hora de exibir — segue a mesma regra do item 26 de nunca gravar pontos junto da colocação
      (só a posição), então mudar a tabela de pontos depois já reflete automaticamente também
      neste painel, sem precisar recalcular nada.
    - **Filtro por nome + data e paginação (10 por página)** na lista "Torneios neste circuito"
      (`circuitoTorneiosFiltroNome`/`circuitoTorneiosFiltroData`/`circuitoTorneiosPagina`,
      resetados ao trocar de circuito — mesmo padrão de `aprovacoesFiltroStatus`/
      `aprovacoesPagina`). Filtro de data casa com torneios cujo intervalo `dataInicio`..`dataFim`
      contém a data escolhida. **Risco novo introduzido por isso e já tratado**: como a lista
      passou a ser parcial (filtrada/paginada), o botão "Salvar vínculos" não pode mais assumir
      que "tudo que não está marcado no DOM foi desmarcado pelo usuário" — um torneio já vinculado
      que está fora da página atual (ou escondido pelo filtro) precisa **manter** seu vínculo.
      Corrigido calculando o novo `torneioIds` como: (vínculos antigos que NÃO estão renderizados
      nesta página) + (o que está marcado entre os renderizados nesta página) — nunca lendo só
      "o que está marcado agora", que apagaria silenciosamente todo vínculo fora da página visível
      no momento do clique. Mesma categoria de risco dos itens 1/13/16/17/32: sempre considerar
      que o DOM visível é só uma fatia do estado real, nunca o estado inteiro.
34. **Circuito virou uma feature admin-only** (pedido explícito — o ranking ficava "confuso"
    sendo self-service; decisão: só `ADMIN_EMAILS` cria/gerencia circuitos, curando quais
    torneios de quais organizadores entram num ranking oficial). Reverte a decisão original do
    item 26 ("disponível pra QUALQUER organizador"):
    - **Front**: o botão "🏆 Circuitos" em `renderTorneiosScreen()` só é renderizado quando
      `ehAdmin()`; o bloco que renderiza `telaCircuitos` em `render()` também checa `ehAdmin()`
      (defesa extra — se `telaCircuitos` ficou setado de uma sessão anterior como admin e a conta
      atual não é mais admin, não renderiza mesmo assim).
    - **Servidor**: `circuitoCriar` e `circuitosList` agora exigem `ehAdmin(solicitanteEmail,
      env)` (403 pra quem não é admin) — nunca confiar só na UI escondida, mesmo padrão do resto
      do app. `circuitosList` também parou de filtrar por `ownerEmail` (já que só admin chega
      lá, um admin deve ver os circuitos criados por outro admin também). `circuitoAtualizar`/
      `circuitoExcluir`/`circuitoResultadoTorneio` **não foram alterados** (continuam
      owner-or-admin / autenticado) — não há necessidade, já que só admin chega a criar um
      circuito daqui pra frente, então `ownerEmail` de um circuito novo sempre vai ser um admin.
    - **Ranking "confuso" também ganhou dois ajustes de apresentação**, nos dois lugares que
      exibem a lista (painel inline dentro do circuito e a página pública compartilhável — agora
      compartilham `renderListaRankingCircuito()`/`medalhaRankingCircuito()`): medalhas 🥇🥈🥉
      pros 3 primeiros (era só "1º"/"2º"/"3º" em texto puro) e uma alternância **Individual /
      Por dupla** (`tabsModoRankingCircuito()`).
    - **Ranking "por dupla"** (`circuitoRanking()` em `worker.ts`, `?modo=dupla`): soma pontos de
      quem jogou JUNTO (mesmo par de jogadores) em mais de um torneio do circuito — resolve a
      confusão de só ver pontos individuais quando jogadores trocam de parceiro entre torneios.
      **Não precisou de nenhum campo novo no schema**: dentro de `resultado.colocacoes` de UM
      torneio, as 1-2 entradas (jogador1/jogador2) de uma mesma dupla sempre compartilham o mesmo
      `duplaNome` — agrupando por `duplaNome` dentro de cada resultado, reconstrói-se a dupla
      original daquele torneio; a chave de agregação ENTRE torneios é o par de CPFs ordenado
      (`[cpf1,cpf2].sort().join("+")`), só quando os dois jogadores têm CPF — mesma regra de "sem
      CPF nunca agrega" do modo individual (item 26), aplicada ao par. Resposta da rota mudou o
      nome do campo de `jogadorNome` para `nome` (genérico o bastante pra cobrir tanto "Fulano"
      quanto "Fulano & Beltrano") — único consumidor é `iniciarRankingPublico`/painel inline,
      então não é uma mudança de API pública com terceiros dependendo dela.
    - **Botão "📊 Ver ranking" dentro da tela de detalhe do circuito** (`painelRankingInlineCircuito`,
      ao lado de "Copiar link"): mostra o mesmo ranking da página pública sem sair do app. Cache
      em memória (`circuitoRankingCache`, chave = circuitoId+modo) evita rebuscar a cada
      re-render — só busca de novo quando abre o painel pela primeira vez ou troca de modo.
35. **CPF preenchido sumia do ranking quando `nomeCompleto` do jogador ficava em branco** —
    reportado com print mostrando "sem CPF" no painel de auditoria mesmo com o CPF visivelmente
    preenchido na dupla, e que "Recalcular" não resolvia. Causa: `colocacoesParaDupla()`
    (`index.html`) só considerava um jogador (`dupla.jogador1`/`jogador2`) como "preenchido" — e
    portanto elegível pra entrar na lista de colocações enviada ao circuito — quando
    `nomeCompleto` estava presente; se só o `cpf` tivesse sido preenchido (fluxo real: o campo
    CPF já tem o placeholder "usado no ranking por circuito", convite direto pra alguém
    preencher só ele numa dupla cujo nome/telefone já existiam de antes), o jogador inteiro era
    filtrado fora **antes mesmo de o cpf ser lido**, caindo no fallback de "dupla sem jogador
    detalhado" (`cpf: null`). Como o cálculo é sempre refeito do zero a partir do `state.duplas`
    atual (nunca cacheado), "Recalcular" repetia exatamente o mesmo resultado — não era um
    problema de dado desatualizado, o dado real não estava sendo lido daquele jogador. Corrigido
    trocando a condição pra "tem `nomeCompleto` **ou** `cpf`" — um jogador com só CPF agora entra
    na lista (usando o nome da dupla como `jogadorNome` de exibição, já que não há nome
    individual pra mostrar, mas o CPF real é preservado pra agregação). **Qualquer filtro que
    decida se um jogador "conta" pro ranking deve considerar CPF e nome como critérios
    independentes** — exigir os dois pra usar qualquer um deles descarta dado real que o
    organizador informou de propósito.
36. **Ranking mostrava o nome da dupla duas vezes, lado a lado, no modo Individual** — efeito
    colateral direto do item 35: quando os DOIS jogadores de uma dupla têm CPF mas nenhum tem
    `nomeCompleto`, os dois entram na lista de colocações (correto — CPF preservado pra cada um),
    mas ambos usam o nome da dupla como `jogadorNome` de exibição — como são CPFs diferentes,
    viram duas linhas SEPARADAS no ranking individual (correto, são duas pessoas reais), só que
    com o texto idêntico, parecendo um bug de duplicação (reportado com print). O modo "Por
    dupla" tinha o mesmo problema de um jeito diferente: `entradas.map(jogadorNome).join(" & ")`
    virava `"Fulano e Beltrano & Fulano e Beltrano"` (o nome da dupla colado nele mesmo) quando
    os dois caíam nesse fallback. Corrigido em `circuitoRanking()` (`worker.ts`), reaproveitando
    o mesmo agrupamento por `(torneioId, duplaNome)` já usado pelo modo dupla (extraído pra
    `agruparPorDupla()`):
    - **Individual**: só desambigua quando há colisão de verdade (mais de um jogador da MESMA
      dupla/torneio caiu no fallback) — nesse caso vira `"{duplaNome} (jogador 1)"` /
      `"(jogador 2)"`, na ordem em que aparecem em `colocacoes` (== ordem jogador1/jogador2).
      Quando só um dos dois cai no fallback (o outro tem nome próprio), não desambigua — não há
      ambiguidade nesse caso, o nome da dupla sozinho já não colide com o nome próprio do parceiro.
    - **Por dupla**: só junta com "&" quando **todos** os jogadores daquela dupla têm nome
      próprio (`nomesReais.length === entradas.length`); caso contrário usa o nome da dupla
      direto, sem juntar nada — nunca produz `"X & X"`.
    - Nenhuma mudança no front — os dois modos só consomem o campo `nome` que a rota já devolve,
      então a correção inteira ficou contida no cálculo do servidor.
37. **Circuito voltou a ser self-service — reverte o item 34** (pedido explícito, depois de usar
    a versão admin-only na prática): qualquer organizador autenticado pode criar/gerenciar seus
    próprios circuitos de novo; admin não cria, mas continua enxergando os circuitos de todo
    mundo (`circuitosList` sem filtro por dono quando `ehAdmin()`) — usado pra auditoria/
    curadoria, não como pré-requisito. Ganhou de quebra o mesmo mecanismo de **acesso
    compartilhado** que torneios já tinham (item 14), agora espelhado em `Circuito`:
    - **Novo campo `Circuito.usuariosPermitidos: string[]`** (mesmo formato de
      `torneio.usuariosPermitidos`) e **`temAcessoCircuito(circuito, email, env)`** no worker,
      mesma fórmula de `temAcessoTorneio`: dono, admin, ou e-mail na lista.
    - **`circuitoAtualizar`** (editar nome/tabela de pontos/torneios vinculados) passou a aceitar
      `temAcessoCircuito` no lugar de "só dono ou admin" — usuário com acesso compartilhado edita
      o circuito como o dono.
    - **`circuitoExcluir` e a gestão da própria lista de usuários continuam só dono+admin**
      (novas rotas `/api/circuito-usuario-adicionar` e `/api/circuito-usuario-remover`, cópia
      quase literal de `torneiosUsuarioAdicionar`/`Remover`) — mesma regra de "acesso operacional,
      não controle total" já usada em torneios: quem foi adicionado não pode excluir o circuito
      nem adicionar/remover outros usuários dessa lista.
    - **`circuitoResultadoTorneio`** (envio automático de resultado ao finalizar um torneio
      vinculado) também passou a usar `temAcessoCircuito` — sem isso, o envio automático de um
      torneio vinculado por um usuário com acesso compartilhado (não o dono) seria silenciosamente
      ignorado (`ignorado: true`) por não bater mais no filtro antigo `ownerEmail===solicitante`.
    - **Front**: removido o gate `ehAdmin()` do botão "🏆 Circuitos" e da renderização de
      `telaCircuitos` (`render()`); tela de listagem ganhou aviso "👑 Modo admin — exibindo os
      circuitos de todas as contas" e mostra o dono de cada circuito quando quem está olhando não
      é o dono (mesmo padrão do aviso já existente em Torneios). Novo card "Usuários com
      acesso a este circuito" (`renderUsuariosPermitidosCircuitoCard`, cópia do
      `renderUsuariosPermitidosCard` de torneio) dentro da tela de detalhe do circuito, com a
      mesma UI de adicionar/remover e-mail — só visível/editável pro dono ou admin; quem tem
      acesso compartilhado só vê a lista (somente leitura).
38. **Ícone do "Apitar jogo" trocado de bandeirada (🏁) por um apito** (pedido explícito — a
    bandeirada remetia a "fim de partida"/corrida, não a apitar um jogo). **Não existe emoji
    Unicode de apito** (é um pedido recorrente na comunidade do Unicode, nunca aprovado), então
    virou um SVG inline pequeno (mesmo espírito dos ícones do menu lateral: `stroke`/`fill:
    currentColor`, herda a cor do texto do botão) — silhueta simples de bocal + corpo oval +
    argola, desenhada e validada visualmente via screenshot (Playwright) antes de aplicar, já que
    não dá pra "ver" o resultado de um path SVG só lendo as coordenadas. Usado só dentro de
    `acoesJogoHtml()` (função compartilhada do botão "Apitar jogo" em todo lugar que uma partida
    aparece — grupos, eliminação, mata-mata) — os outros usos de 🏁 no app (`Fim de partida`,
    indicador `.team.win::after`) foram mantidos, já que ali a bandeirada faz sentido (chegada/
    fim), só o botão que INICIA o apito precisava trocar.
39. **Cards de estatística da aba Resumo (`.stat-grid`/`.stat`) tinham fundo colorido sólido
    (gradiente) e texto branco uniforme** — pedido explícito pra deixar o fundo transparente e
    os dados (`.num`) com cores diferentes entre si, pra ficar mais fácil escanear visualmente
    qual card é qual. Trocado `.stat{background:transparent;border:1.5px solid var(--sand-dark)}`
    (mesmo tratamento visual de `.card`, consistente com o resto do "control room"), e cada
    variante (`.ocean`/`.coral`/`.grass`/`.ink`) agora colore só o `.num` (`var(--ocean)`/
    `var(--coral)`/`var(--grass)`/`var(--ink)` respectivamente) — o `.lbl` abaixo do número fica
    sempre `var(--muted)`, discreto. **`--ink` (não `--heading`) foi escolhido de propósito pra
    variante "Fase atual"**: `--heading` e `--ocean` são tons de verde muito parecidos no tema
    escuro (podiam ficar visualmente iguais a duas casas de distância, ver print), enquanto
    `--ink` é neutro (quase branco) e destoa claramente das outras 3 variantes (2 verdes + 1
    coral) — únicas cores disponíveis na paleta verde/vermelho do app (item 28: sem laranja).
    Único uso de `.stat`/`.stat-grid` no app é `renderResumo()`, então a mudança de CSS não
    afeta nenhuma outra tela.
40. **"Torneios neste circuito" mostrava os torneios do usuário LOGADO, não os do circuito** —
    pedido explícito depois do item 37 (acesso compartilhado): a lista pra vincular torneios a
    um circuito deve mostrar sempre o MESMO conjunto pra qualquer um que abrir aquele circuito —
    torneios do dono do circuito + torneios de cada usuário com acesso compartilhado a ele
    (`circuito.usuariosPermitidos`) — nunca os torneios de quem está simplesmente olhando a tela
    no momento (que podem ser um conjunto totalmente diferente, se for um colaborador ou o
    admin auditando). Antes disso, `renderCircuitoDetalheScreen` reaproveitava `torneiosList`
    (busca genérica de "meus torneios", escopada ao usuário logado via `temAcessoTorneio`) —
    então um colaborador do circuito só via os PRÓPRIOS torneios pra linkar, não os do dono
    (nem vice-versa), a não ser que também tivesse acesso compartilhado torneio a torneio.
    - **Nova rota `GET /api/circuito-torneios-elegiveis?circuito=ID`** (`temAcessoCircuito`
      obrigatório): filtra `torneios:index` por `ownerEmail` estar no conjunto {dono do circuito}
      ∪ {usuariosPermitidos do circuito} — não pelo acesso do solicitante. Novo cache no front
      (`circuitoTorneiosElegiveisCache`, chave = circuito.id) busca sob demanda, invalidado ao
      trocar de circuito ou ao adicionar/remover um usuário compartilhado (o conjunto de donos
      muda).
    - **`circuitoAtualizar` também precisou mudar a checagem de autorização por torneio**: linkar
      um torneio agora é permitido se o DONO do torneio está no mesmo conjunto de colaboradores
      do circuito (`donosCircuito.has(dono do torneio)`) — **além de**, não no lugar de,
      `temAcessoTorneio(torneio, solicitante)` (mantido pra cobrir admin linkando qualquer
      torneio). Sem isso, o dono do circuito conseguia MARCAR a caixinha de um torneio de um
      colaborador (a lista já mostrava certo), mas o `circuitoAtualizar` recusava silenciosamente
      o vínculo (`continue` no loop), porque a checagem antiga só considerava acesso DIRETO do
      solicitante àquele torneio específico.
    - **Nova rota `GET /api/circuito-torneio-dados?circuito=ID&torneio=ID`**: achado só depois de
      testar o fluxo ponta a ponta — mesmo com o vínculo funcionando, o cálculo automático do
      resultado (`calcularResultadoRetroativo`) continuava batendo em `/api/torneios-get`, que
      exige `temAcessoTorneio` do SOLICITANTE (não do circuito) — voltava 403 pro dono do
      circuito tentando processar o torneio de um colaborador. A nova rota autoriza pelo mesmo
      critério do link (`temAcessoCircuito` + dono do torneio no conjunto de colaboradores do
      circuito), devolvendo o registro completo (`state` com duplas/CPFs) só pra esse uso
      específico de leitura — `torneiosGet` continua exigindo acesso direto pra quem quer "abrir
      o torneio" de verdade (editar duplas, jogos etc.), que é um caso de uso mais sensível.
      `calcularResultadoRetroativo`/`enviarResultadoRetroativoParaTorneio` passaram a receber
      `circuitoId` como parâmetro (antes só `torneioId`) — todo call site precisou repassar o
      `circuito.id` já disponível via `data-circuito` nos botões.
41. **Status de "ainda não concluído" de um torneio vinculado sumia ao sair e voltar pra tela do
    circuito** (reportado: "voltam como não processados"). Causa: `statusProcessamentoCircuito`
    (item 32) é só em memória, de propósito — mas isso significa que ela zera em qualquer reload
    de página, não só num logout. Um torneio vinculado que mostrava "⏳ Este torneio ainda não
    foi totalmente finalizado" (com o motivo exato) voltava a cair no `else` genérico "Vinculado,
    ainda não processado" só por ter saído e voltado (ou recarregado a página), mesmo sem nada
    ter mudado de verdade no torneio — parecia que ninguém nunca tinha tentado processar aquele
    vínculo. Corrigido com auto-verificação: ao renderizar `renderCircuitoDetalheScreen`, todo
    torneio vinculado sem `resultado` gravado E sem `statusManual` em memória dispara um
    `calcularResultadoRetroativo()` em segundo plano (dry-run, não envia nada) pra descobrir e
    mostrar o status real, em vez de assumir "nunca processado". Controlado por
    `circuitoTorneiosAutoVerificados` (chave `circuitoId:torneioId`) pra rodar só uma vez por
    sessão por combinação circuito+torneio — evita reconsultar a cada re-render (que aconteceria
    sem essa marca, já que `statusProcessamentoCircuito[t.id]` só é preenchido DEPOIS da promise
    resolver, então o próprio ato de disparar a verificação não impede o próximo render de
    disparar de novo antes da resposta chegar). Continua puramente em memória (mesma decisão do
    item 32) — só que agora se autocorrige sozinho a cada vez que a tela é aberta, em vez de
    depender de o usuário lembrar de clicar em "Verificar novamente" manualmente.
42. **App voltou a ser sempre modo claro — reverte a decisão do item 29** (pedido explícito, com
    print de referência de um outro app — "H.aRchers", dashboard de recrutamento — pedindo pra
    usar as cores e o "modelo" de card/badge/avatar de lá). O bloco `[data-theme="dark"]` e o
    script de boot que forçava `data-theme="dark"` incondicionalmente foram removidos por completo
    (mesmo espírito do item 29 de remover código morto de propósito, só que na direção oposta) —
    hoje só existe um `:root`, sem nenhum atributo de tema nem alternador.
    - **Paleta nova, verde-água/teal** (inspirada no print, não uma cópia literal): `--ocean:
      #2FAE8E`, `--ocean-deep:#1F8A70`, `--coral:#EF5A4C` (mantido pra erro/exclusão/urgência),
      `--grass:#3EDBA6` (ajustado de um tom mais escuro inicial — `#34C495` tinha contraste ruim
      contra `--ocean-deep` no texto "00:00" do cronômetro de partida finalizada, ver abaixo),
      `--sand:#F3F6F5`/`--sand-dark:#E1E7E4` (cinza bem claro, fundo/bordas), `--white:#FFFFFF`,
      `--ink:#1B211F`, `--muted:#8A9490`, `--heading:#1F8A70`. Nova variável `--shadow: 0 10px 30px
      -12px rgba(27,45,40,.18)`, usada no lugar de borda em vários componentes (ver abaixo). As
      variáveis do menu lateral (`--sidebar-*`, item 27) foram realinhadas pra essa mesma paleta
      clara (fundo branco, destaque teal) em vez do preto/verde-neon anterior.
    - **Cor da ação primária mudou de vermelho pra teal**: `.btn` (botão de ação principal em todo
      o app) usava `var(--coral)` como fundo — decisão antiga que já não fazia sentido com o print
      mostrando teal como cor de destaque principal; trocado pra `var(--ocean)` (sombra do botão
      também ajustada pra um tom teal, `rgba(31,138,112,.55)`, em vez do laranja/vermelho antigo).
      `.btn.secondary`/`.btn.ghost` não mudaram (já eram 100% `var(--algumacoisa)`).
    - **Cards ganharam sombra em vez de borda**, imitando o visual "flutuante" do print:
      `.card`, `.stat`, `.dupla-card`, `.group-card`, `.bracket-match`, `.torneio-item` trocaram
      `border:1px/1.5px solid var(--sand-dark)` por `border:none;box-shadow:var(--shadow)` (alguns
      também aumentaram o `border-radius` levemente, 12px→16px, pra ficar mais arredondado como no
      print).
    - **Badges de status (`.status-pill.criado/andamento/finalizado`) viraram pílulas sólidas com
      texto branco** (`background:#0E7FB8`/`var(--coral)`/`var(--grass)`), copiando o estilo de
      alto contraste do print (ex: "AVAILABLE"/"HIRED"). **Decisão deliberada de não mexer nos
      badges gerados via JS com estilo inline** (`badgeAprovacao`, `badgePagamento`,
      `badgeStatusGeral`, `badgeCupom`, `badgeStatusDupla`, badges do Fluxo de Jogos) — eles já
      usavam tons pastel suaves apropriados pro tema claro (herdados de antes do app forçar modo
      escuro), e converter todos pra "sólido" junto com os `.status-pill` deixaria a tela com
      badge demais competindo por atenção. Mistura de estilos (uns sólidos, uns soft-tint) foi
      aceita de propósito.
    - **Avatar (`.user-chip img`) ganhou um anel** (`box-shadow:0 0 0 2px var(--white),0 0 0 3px
      var(--sand-dark)`), parecido com o efeito dos avatares circulares do print.
    - **Bug real encontrado durante a checagem visual (Playwright)**: `input[type=tel]`,
      `input[type=email]` e `input[type=password]` não tinham nenhuma regra de `border-color` —
      só `input[type=text]` tinha; a regra genérica `input,textarea,select{...}` cobria cor/fundo/
      fonte mas nunca borda. Contra o fundo escuro antigo isso quase não aparecia (borda preta
      default do navegador se perdia no fundo escuro); contra os cards brancos novos ficava bem
      visível. Corrigido ampliando o seletor de borda pra incluir esses três tipos (e o `:focus`
      correspondente). **Qualquer novo `<input>` de um tipo diferente de `text` precisa ser
      conferido contra essa mesma lista de seletores**, senão herda só o estilo genérico sem
      borda.
    - **Fora do escopo, de propósito** (mesma exclusão do item 28): Placar de TV (`.tv-screen`) e
      a imagem gerada pro Stories (constantes de cor `GREEN`/`GREEN_DEEP`/`GOLD_BG`/`CORAL` no
      canvas) mantidos exatamente como estavam — têm identidade visual própria, pensada pra ser
      vista de longe/postada, não fazem parte de nenhum pente-fino de tema. `.ref-screen`/
      `.tv-screen` (overlays de tela cheia do apito e do placar de TV) continuam com fundo sólido
      escuro (`--ocean-deep`) por design — não é mais "o tema escuro do app", é só a cor de fundo
      imersiva desses dois overlays específicos, que sempre foi separada do restante da paleta.
43. **Torneio elegível pra circuito não considerava acesso compartilhado ao TORNEIO, só
    propriedade dele** — reportado: um usuário adicionado como colaborador de um torneio (`torneio.
    usuariosPermitidos`, ver item 14) esperava que esse torneio aparecesse na lista de "torneios
    elegíveis" ao criar/editar um circuito próprio, mas só torneios de que ele era **dono** (ou
    dono/colaborador do circuito, ver item 40) apareciam. Causa: `circuitoTorneiosElegiveis`,
    `circuitoAtualizar` (checagem `podeLinkar`) e `circuitoTorneioDados` filtravam só por
    `donos.has(normEmail(torneio.ownerEmail))` — nunca olhavam pro `torneio.usuariosPermitidos`
    do próprio torneio, só pro `circuito.usuariosPermitidos`. Corrigido com um novo helper
    `torneioPertenceAoGrupo(torneio, grupoEmails)` (`worker.ts`) que considera o torneio parte do
    grupo de colaboradores do circuito tanto se algum deles for o DONO quanto se algum deles tiver
    acesso compartilhado ao torneio — usado nos três pontos acima no lugar da checagem que só via
    `ownerEmail`. Efeito: assim que alguém ganha acesso a um torneio (dono ou admin adicionando o
    e-mail dela via "Usuários com acesso a este torneio"), esse torneio já aparece elegível em
    qualquer circuito que essa pessoa administre, sem precisar também virar dono do torneio nem
    ser adicionado à parte como colaborador do circuito. **Qualquer nova checagem de "esse torneio
    pertence a este grupo de gente" deve usar `torneioPertenceAoGrupo`**, nunca comparar só
    `ownerEmail` direto — mesma categoria de risco do item 40 (o conjunto elegível precisa
    refletir todo mundo com acesso real, não só quem é dono).
44. **Faixa de patrocinadores no Placar de TV (`.tv-sponsors`, item 24) removeu o fundo sombreado
    e dobrou o tamanho dos logos** (pedido explícito — a faixa `background:rgba(0,0,0,.28)`
    ficava "pesada" e os logos pequenos demais pra serem lidos de longe, que é o cenário de uso
    real dessa tela). Como os PNGs de patrocinador já têm fundo transparente (`processarLogoPatrocinador`,
    item 24), a faixa escura era só um retângulo decorativo atrás — removida sem substituto (os
    logos ficam direto sobre o fundo do Placar de TV). `.tv-sponsors img{height:...}` dobrado de
    `clamp(26px,4vh,54px)` pra `clamp(52px,8vh,108px)`. Afeta as duas variantes do Placar de TV
    (jogo único e grade de múltiplos jogos, `renderTV`/`renderTVMulti`), já que ambas usam a mesma
    função `sponsorsTvHtml()`/classe CSS — nenhuma mudança de JS foi necessária, só CSS. Não afeta
    a imagem de Stories (`drawSponsorsSection`), que é uma peça de canvas separada e não tem faixa
    de fundo nenhuma pra remover.

## Convenções

- Todo texto visível do app é em português (pt-BR).
- Cores: paleta clara verde-água/teal (item 42 — reverteu a Heineken escura antiga), com
  variáveis CSS (`--ocean`, `--ocean-deep`, `--coral`, `--sand`, `--white`, `--ink`, `--muted`,
  `--heading`, `--shadow`) definidas uma única vez em `:root` — não existe mais `[data-theme]`
  nem alternador de tema. Mesmo assim, nunca usar cor fixa em componente novo, sempre
  `var(--algumacoisa)` — mantém tudo consistente num único lugar caso a paleta mude de novo.
- Toasts (`showToast`) pra feedback rápido; `showLoading()`/`hideLoading()` (overlay com spinner)
  pra ações que demoram (rede).
- E-mails automáticos (aprovação, pagamento, novo torneio) são enviados via `enviarEmail()` no
  worker, usando as credenciais SMTP do Gmail.
