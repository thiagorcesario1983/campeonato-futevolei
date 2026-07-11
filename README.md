# Futevôlei — App do Campeonato (Cloudflare Workers)

Esta é a versão migrada do Netlify para o **Cloudflare Workers**. Mesmo app, mesmas funcionalidades (sorteio, jogos, classificação, mata-mata, WhatsApp, Telegram automático, torneios na nuvem com login Google) — só o "motor" por trás mudou.

## O que já está pronto

- O banco de dados (Cloudflare KV) **já foi criado** — namespace `campeonato-futevolei-db`, já referenciado no `wrangler.jsonc`
- O único Worker (`src/worker.ts`) já tem as 7 rotas que antes eram 7 functions separadas do Netlify:
  - `/api/telegram-webhook`, `/api/telegram-send`, `/api/telegram-status`
  - `/api/torneios-save`, `/api/torneios-list`, `/api/torneios-get`, `/api/torneios-delete`

## Como publicar (passo a passo)

### 1. Instalar o Node.js
Se ainda não tiver, baixe em [nodejs.org](https://nodejs.org/) (versão LTS).

### 2. Entrar na pasta do projeto e instalar as dependências
```
cd caminho/para/cf-migration
npm install
```

### 3. Fazer login na Cloudflare
```
npx wrangler login
```
Abre o navegador para você autorizar — use a mesma conta onde o KV foi criado.

### 4. Publicar
```
npx wrangler deploy
```
Isso mostra a URL do seu site, algo como `https://campeonato-futevolei.<seu-usuario>.workers.dev`.

### 5. Configurar o token do Telegram
```
npx wrangler secret put TELEGRAM_BOT_TOKEN
```
Cole o token quando pedir (o mesmo que você já usava no Netlify).

### 6. Testar localmente antes de publicar (opcional)
```
npx wrangler dev
```
Isso roda tudo — Worker + KV + assets — no seu computador, em `http://localhost:8787`, com o banco de dados de verdade (mesmo ambiente de produção). Diferente do Netlify, aqui o dev local já funciona completo sem precisar de nada extra.

## Depois de publicar: atualizar as integrações externas

Como o endereço do site muda (de `.netlify.app` para `.workers.dev`, ou um domínio próprio se você configurar um), é preciso atualizar 2 coisas que apontam para o endereço antigo:

### Webhook do Telegram
Abra este link no navegador, trocando `SEU_TOKEN` e `SEU_NOVO_ENDERECO`:
```
https://api.telegram.org/botSEU_TOKEN/setWebhook?url=https://SEU_NOVO_ENDERECO/api/telegram-webhook
```

### Login com Google
No [Google Cloud Console](https://console.cloud.google.com/) → Credenciais → seu Client ID → adicione o novo endereço em **"Origens JavaScript autorizadas"** (mantenha o antigo também, não tem problema ter os dois).

## Diferenças em relação à versão Netlify

- **Um Worker só**, não 7 arquivos separados — mais simples de entender, mesma funcionalidade
- **Cloudflare KV** no lugar do Netlify Blobs — mesmo conceito (chave → valor), API ligeiramente diferente, já adaptada no código
- **Sem limite de deploys por mês** no plano gratuito da Cloudflare (o problema que motivou a migração) — o Workers grátis tem limite generoso de *requisições*, não de quantas vezes você publica
- **`wrangler dev` funciona 100% local**, incluindo o banco de dados — no Netlify isso exigia `netlify dev` configurado; aqui já vem assim

## Arquivos

- `public/` — o app (HTML, CSS, JS, ícones, manifest, service worker) — igual à versão Netlify
- `src/worker.ts` — todas as rotas de API em um único Worker
- `wrangler.jsonc` — configuração do projeto (nome, KV, pasta de assets)
- `package.json` — dependência do Wrangler (ferramenta de deploy)
