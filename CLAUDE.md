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
    - **Ponto de entrada não pode usar o mecanismo `telaAdmin`/`nav-admin` existente** (Cupons/
      Aprovações/Config/Log) porque esse é gated por `ehAdmin()` (admin GLOBAL do app via
      `ADMIN_EMAILS`) — circuito precisa estar disponível pra QUALQUER organizador agrupar os
      próprios torneios. Por isso ganhou uma variável de tela própria (`telaCircuitos`, solta,
      não gated por `ehAdmin()`) dentro da própria `renderTorneiosScreen()` — que, como as
      outras, só é renderizada quando `!state.cloudId` (fora de um torneio aberto); entrar num
      torneio e sair de novo ("Trocar torneio") não zera `telaCircuitos` sozinho, mesmo
      comportamento já existente de `telaAdmin` hoje.
    - **`torneioIds` do circuito tem um campo espelho em cada torneio** (`torneio.circuitoIds`,
      top-level no registro completo — ao lado de `pagamento`, não dentro de `state` —, escrito
      só por `circuito-atualizar`, nunca pelo cliente): `torneiosSave` sempre preserva esse campo
      a partir do registro existente, ignorando o que vier em `body.state.circuitoIds`, mesmo
      padrão de proteção já usado pra `pagamento` (item 1). Ao linkar um torneio a um circuito,
      o servidor exige que o solicitante tenha `temAcessoTorneio` daquele torneio específico —
      sem essa checagem, o dono de um circuito poderia colar o id de um torneio de outro
      organizador e vazar nomes/CPFs das duplas dele no ranking público.
    - Envio automático (`verificarEnvioResultadoCircuito`, chamada em `save()`) dispara sempre
      que `torneioTotalmenteFinalizado()` (item 25) for true e o torneio estiver vinculado a
      algum circuito — fire-and-forget, idempotente do lado do servidor (sempre sobrescreve o
      resultado daquele torneio), com uma marca local (`circuitoResultadoEnviadoEm`) só pra não
      bater na rede a cada `save()` sem necessidade.
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
