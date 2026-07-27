// Valida a sintaxe do JS embutido no public/index.html.
// O front-end é um arquivo único sem build step, então nada verifica esse
// <script> gigante — um erro de sintaxe só aparece como tela branca no navegador.
// Roda com: npm run check   (ou task "Checar sintaxe do index.html" no VS Code)
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const html = readFileSync("public/index.html", "utf8");

// Só os <script> sem atributos — os com src/type são externos ou não são JS.
const blocos = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);

if (blocos.length === 0) {
  console.error("Nenhum <script> inline encontrado em public/index.html.");
  process.exit(1);
}

const dir = mkdtempSync(join(tmpdir(), "ftv-check-"));
let falhou = false;

blocos.forEach((codigo, i) => {
  const arquivo = join(dir, `bloco-${i}.js`);
  writeFileSync(arquivo, codigo, "utf8");
  try {
    execFileSync(process.execPath, ["--check", arquivo], { stdio: "pipe" });
    console.log(`ok   bloco ${i + 1}/${blocos.length} (${codigo.split("\n").length} linhas)`);
  } catch (err) {
    falhou = true;
    console.error(`ERRO bloco ${i + 1}/${blocos.length}:`);
    console.error(String(err.stderr || err.message));
  }
});

if (falhou) process.exit(1);
console.log("\nSintaxe ok.");
