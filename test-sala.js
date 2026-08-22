"use strict";
/*
 * Exercita a sala online de ponta a ponta, sem rede e sem instalar nada.
 *
 * Truque: antes de carregar o server.js, o teste coloca um dublê do pacote `ws`
 * no cache do require. O dublê não fala o protocolo WebSocket de verdade — ele
 * só oferece a mesma superfície (send/close/ping/on) e guarda o que foi
 * enviado, o que basta para conferir toda a lógica de salas.
 *
 * Rode com:  node test-sala.js
 */

const { EventEmitter } = require("events");
const path = require("path");
const Module = require("module");

// ---------------------------------------------------------------------------
// Dublê do pacote ws
// ---------------------------------------------------------------------------

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.readyState = 1;      // OPEN
    this.enviadas = [];
  }
  send(texto) {
    if (this.readyState !== 1) return;
    this.enviadas.push(typeof texto === "string" ? JSON.parse(texto) : texto);
  }
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit("close");
  }
  terminate() { this.close(); }
  ping() { this.emit("pong"); }

  receber(objeto) { this.emit("message", Buffer.from(JSON.stringify(objeto)), false); }
  ultima(tipo) {
    for (let i = this.enviadas.length - 1; i >= 0; i--) {
      if (!tipo || this.enviadas[i].t === tipo) return this.enviadas[i];
    }
    return null;
  }
  todas(tipo) { return this.enviadas.filter(m => m.t === tipo); }
  limpar() { this.enviadas.length = 0; }
}

let socketRecemCriado = null;

class WebSocketServer extends EventEmitter {
  constructor(opcoes) { super(); this.opcoes = opcoes || {}; }
  handleUpgrade(req, socket, head, cb) {
    const fake = new FakeSocket();
    socketRecemCriado = fake;
    cb(fake, req);
  }
}

const dublê = {
  WebSocketServer: WebSocketServer,
  Server: WebSocketServer,
  WebSocket: { OPEN: 1, CLOSED: 3, CONNECTING: 0, CLOSING: 2 }
};

// Planta o dublê no cache do require, com o nome que o server.js pede.
const caminhoFalso = path.join(__dirname, "node_modules", "ws", "index.js");
const moduloFalso = new Module(caminhoFalso, null);
moduloFalso.filename = caminhoFalso;
moduloFalso.loaded = true;
moduloFalso.exports = dublê;
require.cache[caminhoFalso] = moduloFalso;
const resolverOriginal = Module._resolveFilename;
Module._resolveFilename = function (pedido, pai, ehPrincipal, opcoes) {
  if (pedido === "ws") return caminhoFalso;
  return resolverOriginal.call(this, pedido, pai, ehPrincipal, opcoes);
};

// ---------------------------------------------------------------------------
// Sobe o servidor sem abrir porta de verdade
// ---------------------------------------------------------------------------

process.env.TURBO_PORT = "0";
process.env.TURBO_HOST = "127.0.0.1";

const http = require("http");
let servidorHttp = null;
const criarOriginal = http.createServer;
http.createServer = function (manipulador) {
  const s = criarOriginal(manipulador);
  servidorHttp = s;
  s.listen = function () { return s; };   // não abre porta durante o teste
  return s;
};
const moduloServidor = require("./server.js");
http.createServer = criarOriginal;

if (!servidorHttp) {
  console.error("FALHOU: nao achei o servidor HTTP");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Conferências
// ---------------------------------------------------------------------------

let falhas = 0;
function conferir(condicao, descricao) {
  if (condicao) {
    console.log("  ok  " + descricao);
  } else {
    console.log("  X   " + descricao);
    falhas++;
  }
}

function conectar(consulta) {
  const req = { url: "/corrida?" + consulta, headers: { host: "teste" } };
  const socketCru = new EventEmitter();
  socketCru.destroy = function () {};
  socketCru.write = function () {};
  socketRecemCriado = null;
  servidorHttp.listeners("upgrade")[0](req, socketCru, Buffer.alloc(0));
  return socketRecemCriado;
}

console.log("\n1) Criar sala e entrar com o codigo");
const anfitriao = conectar("criar=1&nome=Arley&carro=4&max=24&fase=3&salaNome=Desafio&clima=rain_heavy&pocaAgua=1&pocaOleo=0&voltas=6");
const bemvindo = anfitriao.ultima("bemvindo");
conferir(!!bemvindo, "o anfitriao recebeu bemvindo");
conferir(bemvindo && bemvindo.anfitriao === true, "quem cria a sala vira anfitriao");
conferir(bemvindo && bemvindo.resumo.fase === 3, "a fase pedida na criacao foi guardada");
conferir(bemvindo && bemvindo.resumo.nome === "Desafio", "o nome escolhido foi guardado");
conferir(bemvindo && bemvindo.resumo.maxJogadores === 24, "a sala aceita o teto de 24 jogadores");
conferir(bemvindo && bemvindo.resumo.clima === "rain_heavy", "o clima escolhido foi guardado");
conferir(bemvindo && bemvindo.resumo.pocaAgua === true && bemvindo.resumo.pocaOleo === false,
  "as opcoes de agua e oleo foram guardadas");
conferir(bemvindo && bemvindo.resumo.voltas === 6, "o numero de voltas foi guardado");
const salaId = bemvindo.sala;
conferir(/^[A-Z2-9]{6}$/.test(salaId), "o codigo da sala tem 6 caracteres faceis de ditar: " + salaId);

const convidado = conectar("sala=" + salaId + "&nome=Bia&carro=1");
conferir(!!convidado.ultima("bemvindo"), "o convidado entrou pelo codigo");
conferir(convidado.ultima("bemvindo").anfitriao === false, "o convidado nao e anfitriao");
const pidDoConvidado = convidado.ultima("bemvindo").pid;
conferir(anfitriao.ultima("sala").resumo.jogadores.length === 2, "o anfitriao viu a sala com 2 jogadores");

console.log("\n2) Sala que nao existe");
const inexistente = conectar("sala=ZZZZZZ&nome=Ninguem");
conferir(!!inexistente.ultima("erro"), "entrar numa sala que nao existe devolve erro");

console.log("\n3) So o anfitriao muda a fase");
convidado.limpar(); anfitriao.limpar();
convidado.receber({ t: "fase", fase: 20 });
conferir(anfitriao.ultima("sala") === null || anfitriao.ultima("sala").resumo.fase === 3,
  "convidado nao consegue trocar a fase");
anfitriao.receber({ t: "fase", fase: 17 });
conferir(convidado.ultima("sala").resumo.fase === 17, "o anfitriao trocou a fase e todos viram");

console.log("\n4) Pronto e largada com a mesma semente");
anfitriao.limpar(); convidado.limpar();
convidado.receber({ t: "pronto", pronto: true });
conferir(anfitriao.ultima("sala").resumo.jogadores.some(j => j.nome === "Bia" && j.pronto),
  "o pronto do convidado apareceu para o anfitriao");

anfitriao.receber({ t: "largar" });
const largadaA = anfitriao.ultima("largada");
const largadaB = convidado.ultima("largada");
conferir(!!largadaA && !!largadaB, "os dois receberam a largada");
conferir(largadaA.semente === largadaB.semente, "a semente da pista e a mesma para os dois");
conferir(largadaA.fase === 17 && largadaB.fase === 17, "os dois correm a mesma fase");
conferir(largadaA.voltas === 6 && largadaB.voltas === 6, "os dois correm as mesmas 6 voltas");
conferir(largadaA.clima === "rain_heavy" && largadaB.clima === "rain_heavy", "os dois recebem o mesmo clima");
conferir(largadaA.pocaAgua === true && largadaB.pocaAgua === true && largadaA.pocaOleo === false && largadaB.pocaOleo === false,
  "os dois recebem as mesmas opcoes de pocas");
conferir(largadaA.semente > 0, "a semente e um numero utilizavel: " + largadaA.semente);
conferir(largadaA.sincronizarEmMs === 6000 && largadaB.sincronizarEmMs === 6000,
  "PC e celular recebem o mesmo prazo sincronizado para o GO");
conferir(largadaA.emMs === 3000 && largadaB.emMs === 3000,
  "o prazo legado foi preservado para aplicativos antigos");

console.log("\n5) Nao da para entrar no meio da corrida");
const atrasado = conectar("sala=" + salaId + "&nome=Tarde");
conferir(!!atrasado.ultima("erro"), "quem chega com a corrida rolando recebe erro");

console.log("\n6) Repasse de estado");
anfitriao.limpar(); convidado.limpar();
anfitriao.receber({ t: "estado", x: 0.5, position: 1234.5, speed: 900, lap: 1, fuel: 0.8, carId: 4, rank: 1, finished: false });
const estado = convidado.ultima("estado");
conferir(!!estado, "o estado do anfitriao chegou no convidado");
conferir(estado && estado.playerName === "Arley", "o servidor carimba o nome de quem enviou");
conferir(estado && Math.abs(estado.position - 1234.5) < 0.001, "a posicao passou intacta");
conferir(anfitriao.ultima("estado") === null, "quem enviou nao recebe o proprio estado de volta");

console.log("\n7) Teto de mensagens por segundo");
convidado.limpar();
for (let i = 0; i < 200; i++) {
  anfitriao.receber({ t: "estado", x: 0, position: i, speed: 1, lap: 0, fuel: 1, carId: 4, rank: 1 });
}
conferir(convidado.todas("estado").length <= 41,
  "o servidor corta a enxurrada de estados: " + convidado.todas("estado").length);

console.log("\n8) Chegada e fim de corrida");
anfitriao.limpar(); convidado.limpar();
anfitriao.receber({ t: "chegou", tempo: 121.5 });
const chegouA = convidado.ultima("chegou");
conferir(!!chegouA && chegouA.posicao === 1, "quem chega primeiro recebe a posicao 1 do servidor");
convidado.receber({ t: "chegou", tempo: 128.0 });
const fim = anfitriao.ultima("fim");
conferir(!!fim, "com todos na linha de chegada o servidor fecha a corrida");
conferir(fim && fim.ordem.length === 2 && fim.ordem[0].nome === "Arley", "a ordem de chegada saiu certa");
conferir(anfitriao.ultima("sala").resumo.correndo === false, "a sala voltou para o saguao");

console.log("\n9) Conversa curta");
convidado.limpar();
anfitriao.receber({ t: "conversa", texto: "Boa corrida! <script>" });
const conversa = convidado.ultima("conversa");
conferir(!!conversa, "a provocacao chegou do outro lado");
conferir(conversa && conversa.texto.indexOf("<") < 0, "os sinais < e > foram removidos do texto");

console.log("\n10) Anfitriao sai e a sala continua");
anfitriao.receber({ t: "sair" });
const resumoDepois = convidado.ultima("sala");
conferir(resumoDepois.resumo.jogadores.length === 1, "sobrou 1 jogador na sala");
conferir(resumoDepois.resumo.anfitriaoPid === pidDoConvidado, "o convidado virou o novo anfitriao");

console.log("\n11) /status e /salas respondem");
function pedir(caminho) {
  return new Promise(function (ok) {
    const req = { url: caminho, method: "GET", headers: { host: "teste" } };
    let corpo = "";
    const res = {
      writeHead() {},
      end(dados) { corpo += dados ? dados.toString() : ""; ok(corpo); }
    };
    servidorHttp.listeners("request")[0](req, res);
  });
}

Promise.all([pedir("/status"), pedir("/salas")]).then(function (respostas) {
  const status = JSON.parse(respostas[0]);
  const listagem = JSON.parse(respostas[1]);
  conferir(status.ok === true && status.jogo === "Turbo Race", "/status responde com o nome do jogo");
  conferir(status.maxPorSala === 24, "/status informa o teto de 24 por sala");
  conferir(Array.isArray(listagem.salas) && listagem.salas.length >= 1, "/salas lista a sala aberta");

  console.log("\n12) Sala com apenas um jogador expira em 5 minutos");
  const salaSozinha = moduloServidor.teste.salas.get(salaId);
  conferir(!!salaSozinha && salaSozinha.sozinhaDesde > 0,
    "o relogio de inatividade comecou quando sobrou apenas um jogador");
  const agoraSozinha = Date.now();
  salaSozinha.sozinhaDesde = agoraSozinha - moduloServidor.teste.salaSozinhaMs + 1;
  moduloServidor.teste.varrerSalas(agoraSozinha);
  conferir(moduloServidor.teste.salas.has(salaId), "a sala continua antes de completar 5 minutos");
  salaSozinha.sozinhaDesde = agoraSozinha - moduloServidor.teste.salaSozinhaMs;
  moduloServidor.teste.varrerSalas(agoraSozinha);
  conferir(!moduloServidor.teste.salas.has(salaId), "a sala some ao completar 5 minutos sozinha");
  conferir(convidado.readyState === 3, "o jogador restante recebe o encerramento da sala");

  console.log("\n13) Sala totalmente vazia expira em 2 minutos");
  const donoDaVazia = conectar("criar=1&nome=Temporario&salaNome=Vazia");
  const idDaVazia = donoDaVazia.ultima("bemvindo").sala;
  donoDaVazia.receber({ t: "sair" });
  const salaVazia = moduloServidor.teste.salas.get(idDaVazia);
  conferir(!!salaVazia && salaVazia.vaziaDesde > 0, "o relogio comecou quando todos sairam");
  const inicioVazia = salaVazia.vaziaDesde;
  moduloServidor.teste.varrerSalas(inicioVazia + moduloServidor.teste.salaVaziaMs - 1);
  conferir(moduloServidor.teste.salas.has(idDaVazia), "a sala vazia continua antes de 120 segundos");
  moduloServidor.teste.varrerSalas(inicioVazia + moduloServidor.teste.salaVaziaMs);
  conferir(!moduloServidor.teste.salas.has(idDaVazia), "a sala vazia some ao completar 120 segundos");

  console.log("\n14) Limpeza permanente remove sala abandonada com sockets abertos");
  const donoInativo = conectar("criar=1&nome=Parado&salaNome=Abandonada");
  const idInativa = donoInativo.ultima("bemvindo").sala;
  const outroInativo = conectar("sala=" + idInativa + "&nome=Esquecido");
  const salaInativa = moduloServidor.teste.salas.get(idInativa);
  conferir(!!salaInativa && salaInativa.sozinhaDesde === 0,
    "dois sockets abertos nao usam o prazo de sala sozinha");
  const agoraInativa = Date.now();
  salaInativa.ultimaAtividadeEm = agoraInativa - moduloServidor.teste.salaInativaMs + 1;
  moduloServidor.teste.varrerSalas(agoraInativa);
  conferir(moduloServidor.teste.salas.has(idInativa), "a sala continua um instante antes de 5 minutos inativa");
  salaInativa.ultimaAtividadeEm = agoraInativa - moduloServidor.teste.salaInativaMs;
  moduloServidor.teste.varrerSalas(agoraInativa);
  conferir(!moduloServidor.teste.salas.has(idInativa), "a limpeza remove a sala inativa mesmo com sockets abertos");
  conferir(donoInativo.readyState === 3 && outroInativo.readyState === 3,
    "a limpeza fecha todos os sockets abandonados");

  console.log("\n" + (falhas === 0 ? "TUDO PASSOU" : falhas + " CONFERENCIA(S) FALHARAM"));
  process.exit(falhas === 0 ? 0 : 1);
});
