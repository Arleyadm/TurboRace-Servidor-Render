"use strict";

/*
 * Sala online do Turbo Race.
 *
 * E um repassador (relay) WebSocket: o servidor nao simula a corrida, so
 * organiza as salas, decide quando todo mundo larga e repassa a posicao de
 * cada carro para os outros. O estado vive so na memoria — se o processo
 * reiniciar, as salas somem, e tudo bem: uma corrida dura minutos.
 *
 * O desenho e o mesmo do servidor do Sugar Strike (Node + ws, varias salas,
 * upgrade so num caminho, /status para conferir de fora), mas este e um
 * projeto separado, com repositorio e servico proprios no Render. Nada aqui
 * toca no Sugar Strike.
 *
 * Como todos correm a MESMA fase, o anfitriao escolhe a pista e o servidor
 * manda uma semente na largada. Cada jogo gera a pista com essa semente, entao
 * o traçado, o cenario, as moedas e o trafego saem identicos nas telas de todos.
 */

const http = require("http");
const crypto = require("crypto");
const { WebSocketServer, WebSocket } = require("ws");

// A hospedagem escolhe a porta pela variavel PORT; no computador vale a TURBO_PORT.
const PORT = Math.max(1024, Math.min(65535, Number(process.env.PORT || process.env.TURBO_PORT) || 8788));
// Na nuvem e preciso aceitar conexoes de fora; no computador, so do proprio tunel.
const HOST = process.env.TURBO_HOST || (process.env.PORT ? "0.0.0.0" : "127.0.0.1");

const VERSAO = "1.3.0";
const CAMINHO_WS = "/corrida";

const MIN_JOGADORES = 2;
const MAX_JOGADORES = 24;
const MAX_SALAS = 60;
const MAX_BYTES_MENSAGEM = 16 * 1024;
const TOTAL_FASES = 28;

// Quem cai volta para a mesma sala se reconectar dentro desse tempo.
const RECONEXAO_MS = 15000;
// Sala totalmente vazia some em 2 minutos. Se apenas o anfitriao (ou outro
// piloto sozinho) continuar conectado, ela aguarda 5 minutos por mais alguem.
// Com dois ou mais pilotos nao ha expiracao por espera.
const SALA_VAZIA_MS = 120000;
const SALA_SOZINHA_MS = 300000;
const VARREDURA_MS = 10000;
// Quem nao responde ao ping neste tempo e considerado desconectado.
const BATIMENTO_MS = 30000;

// Quantas mensagens de estado um jogador pode mandar por segundo. O cliente
// manda ~15/s; o teto e folgado so para barrar cliente estragado.
const ESTADOS_POR_SEGUNDO = 40;

const salas = new Map();     // id -> sala
const sessoes = new Map();   // token -> cliente (para reconexao)

function novoIdDeSala() {
  // Codigo curto e facil de ditar por telefone, sem letras que se confundem.
  const alfabeto = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let saida = "";
  const bytes = crypto.randomBytes(6);
  for (let i = 0; i < 6; i++) saida += alfabeto[bytes[i] % alfabeto.length];
  return saida;
}

function novoToken() {
  return crypto.randomBytes(24).toString("base64url");
}

function novoPid() {
  return crypto.randomBytes(8).toString("hex");
}

/** Tira caracteres de controle e os sinais que quebrariam o HTML do jogo. */
function limpar(valor, reserva, maximo) {
  const origem = String(valor == null ? "" : valor);
  let texto = "";
  for (let i = 0; i < origem.length; i++) {
    const codigo = origem.charCodeAt(i);
    if (codigo < 32 || codigo === 127) continue;
    if (codigo === 60 || codigo === 62) continue;   // < e >
    texto += origem.charAt(i);
  }
  texto = texto.trim();
  return (texto || reserva).slice(0, maximo);
}

function numero(valor, padrao, minimo, maximo) {
  const n = Number(valor);
  if (!Number.isFinite(n)) return padrao;
  return Math.max(minimo, Math.min(maximo, n));
}

function inteiro(valor, padrao, minimo, maximo) {
  return Math.trunc(numero(valor, padrao, minimo, maximo));
}

function json(res, status, corpo) {
  const carga = Buffer.from(JSON.stringify(corpo, null, 2));
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": carga.length,
    "cache-control": "no-store",
    // O jogo pode rodar de file:// dentro de um WebView, e ai a origem chega como "null".
    "access-control-allow-origin": "*"
  });
  res.end(carga);
}

// ---------------------------------------------------------------------------
// Salas
// ---------------------------------------------------------------------------

const CLIMAS = new Set(["auto", "sun", "rain_light", "rain_heavy", "snow", "fog", "night"]);

function booleano(valor, padrao) {
  if (valor == null || valor === "") return padrao;
  return valor === true || valor === 1 || valor === "1" || String(valor).toLowerCase() === "true";
}

function climaSeguro(valor) {
  const clima = String(valor || "auto").toLowerCase();
  return CLIMAS.has(clima) ? clima : "auto";
}

function criarSala(nomeDaSala, maxJogadores, fase, configuracao) {
  if (salas.size >= MAX_SALAS) return null;
  let id = novoIdDeSala();
  let tentativas = 0;
  while (salas.has(id) && tentativas < 12) { id = novoIdDeSala(); tentativas++; }
  if (salas.has(id)) return null;

  const sala = {
    id: id,
    nome: nomeDaSala,
    maxJogadores: maxJogadores,
    fase: fase,
    clima: climaSeguro(configuracao && configuracao.clima),
    pocaAgua: booleano(configuracao && configuracao.pocaAgua, true),
    pocaOleo: booleano(configuracao && configuracao.pocaOleo, true),
    voltas: inteiro(configuracao && configuracao.voltas, 3, 1, 10),
    anfitriaoPid: "",
    correndo: false,
    semente: 0,
    corridaId: "",
    largadaEm: 0,
    clientes: new Map(),      // pid -> cliente
    criadaEm: Date.now(),
    vaziaDesde: Date.now(),
    sozinhaDesde: 0
  };
  salas.set(id, sala);
  return sala;
}

function conectados(sala) {
  let total = 0;
  for (const cliente of sala.clientes.values()) {
    if (cliente.ws && cliente.ws.readyState === WebSocket.OPEN) total++;
  }
  return total;
}

function atualizarEsperaSozinha(sala, agora) {
  const instante = agora || Date.now();
  const total = conectados(sala);
  if (sala.correndo || total >= 2) {
    sala.vaziaDesde = 0;
    sala.sozinhaDesde = 0;
  } else if (total === 1) {
    sala.vaziaDesde = 0;
    if (!sala.sozinhaDesde) sala.sozinhaDesde = instante;
  } else {
    sala.sozinhaDesde = 0;
    if (!sala.vaziaDesde) sala.vaziaDesde = instante;
  }
}

function resumoDaSala(sala) {
  const jogadores = [];
  for (const cliente of sala.clientes.values()) {
    jogadores.push({
      pid: cliente.pid,
      nome: cliente.nome,
      carId: cliente.carId,
      pronto: cliente.pronto,
      anfitriao: cliente.pid === sala.anfitriaoPid,
      online: !!(cliente.ws && cliente.ws.readyState === WebSocket.OPEN),
      terminou: cliente.terminou,
      posicaoFinal: cliente.posicaoFinal,
      tempoFinal: cliente.tempoFinal
    });
  }
  return {
    id: sala.id,
    nome: sala.nome,
    fase: sala.fase,
    clima: sala.clima,
    pocaAgua: sala.pocaAgua,
    pocaOleo: sala.pocaOleo,
    voltas: sala.voltas,
    maxJogadores: sala.maxJogadores,
    minJogadores: MIN_JOGADORES,
    anfitriaoPid: sala.anfitriaoPid,
    correndo: sala.correndo,
    corridaId: sala.corridaId,
    jogadores: jogadores
  };
}

function enviar(cliente, objeto) {
  if (!cliente.ws || cliente.ws.readyState !== WebSocket.OPEN) return;
  try { cliente.ws.send(JSON.stringify(objeto)); } catch (e) { /* socket morrendo */ }
}

function transmitir(sala, objeto, exceto) {
  const texto = JSON.stringify(objeto);
  for (const cliente of sala.clientes.values()) {
    if (exceto && cliente.pid === exceto.pid) continue;
    if (!cliente.ws || cliente.ws.readyState !== WebSocket.OPEN) continue;
    try { cliente.ws.send(texto); } catch (e) { /* socket morrendo */ }
  }
}

function avisarSala(sala) {
  transmitir(sala, { t: "sala", resumo: resumoDaSala(sala) });
}

/** Escolhe um novo anfitriao quando o antigo sai. */
function passarOAnfitriao(sala) {
  if (sala.clientes.has(sala.anfitriaoPid)) {
    const atual = sala.clientes.get(sala.anfitriaoPid);
    if (atual.ws && atual.ws.readyState === WebSocket.OPEN) return;
  }
  for (const cliente of sala.clientes.values()) {
    if (cliente.ws && cliente.ws.readyState === WebSocket.OPEN) {
      sala.anfitriaoPid = cliente.pid;
      return;
    }
  }
  sala.anfitriaoPid = "";
}

function tirarDaSala(sala, cliente, motivo) {
  sala.clientes.delete(cliente.pid);
  sessoes.delete(cliente.token);
  passarOAnfitriao(sala);
  atualizarEsperaSozinha(sala);
  if (sala.clientes.size === 0) {
    return;
  } else {
    transmitir(sala, { t: "saiu", pid: cliente.pid, motivo: motivo || "" });
    avisarSala(sala);
  }
}

/** Sala aberta e com vaga, para quem clicou em "entrar em qualquer sala". */
function salaComVaga() {
  for (const sala of salas.values()) {
    if (sala.correndo) continue;
    if (conectados(sala) >= sala.maxJogadores) continue;
    return sala;
  }
  return null;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

const servidor = http.createServer(function (req, res) {
  varrerSalas();
  const url = new URL(req.url, "http://" + (req.headers.host || "localhost"));

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "content-type",
      "access-control-allow-methods": "GET, OPTIONS"
    });
    res.end();
    return;
  }

  if (url.pathname === "/status") {
    let jogadores = 0;
    let correndo = 0;
    for (const sala of salas.values()) {
      jogadores += conectados(sala);
      if (sala.correndo) correndo++;
    }
    json(res, 200, {
      ok: true,
      jogo: "Turbo Race",
      versao: VERSAO,
      salas: salas.size,
      jogadores: jogadores,
      corridasEmAndamento: correndo,
      maxPorSala: MAX_JOGADORES,
      minPorSala: MIN_JOGADORES,
      maxSalas: MAX_SALAS,
      caminhoWebSocket: CAMINHO_WS,
      tempoDePeMs: Math.trunc(process.uptime() * 1000)
    });
    return;
  }

  if (url.pathname === "/salas") {
    const lista = [];
    for (const sala of salas.values()) {
      lista.push({
        id: sala.id,
        nome: sala.nome,
        fase: sala.fase,
        clima: sala.clima,
        pocaAgua: sala.pocaAgua,
        pocaOleo: sala.pocaOleo,
        voltas: sala.voltas,
        jogadores: conectados(sala),
        maxJogadores: sala.maxJogadores,
        correndo: sala.correndo
      });
    }
    lista.sort((a, b) => b.jogadores - a.jogadores);
    json(res, 200, { ok: true, salas: lista });
    return;
  }

  if (url.pathname === "/") {
    const corpo = Buffer.from(
      "Sala online do Turbo Race.\n\n" +
      "Status: /status\nSalas abertas: /salas\nJogo: ws" + CAMINHO_WS + "\n",
      "utf8"
    );
    res.writeHead(200, {
      "content-type": "text/plain; charset=utf-8",
      "content-length": corpo.length,
      "access-control-allow-origin": "*"
    });
    res.end(corpo);
    return;
  }

  json(res, 404, { ok: false, erro: "caminho desconhecido" });
});

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------

const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_BYTES_MENSAGEM });

servidor.on("upgrade", function (req, socket, head) {
  varrerSalas();
  let url;
  try {
    url = new URL(req.url, "http://" + (req.headers.host || "localhost"));
  } catch (e) {
    socket.destroy();
    return;
  }

  // Aceita so o caminho do jogo: qualquer outro upgrade e recusado.
  if (url.pathname !== CAMINHO_WS) {
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, function (ws) {
    aoConectar(ws, url);
  });
});

function aoConectar(ws, url) {
  const nome = limpar(url.searchParams.get("nome"), "Jogador", 14);
  const carId = inteiro(url.searchParams.get("carro"), 0, 0, 9);
  const tokenAntigo = url.searchParams.get("token") || "";
  const querCriar = url.searchParams.get("criar") === "1";
  const idPedido = limpar(url.searchParams.get("sala"), "", 8).toUpperCase();

  // --- Reconexao: volta para a mesma sala e mantem o mesmo pid ---
  if (tokenAntigo && sessoes.has(tokenAntigo)) {
    const antigo = sessoes.get(tokenAntigo);
    const sala = salas.get(antigo.salaId);
    if (sala && sala.clientes.has(antigo.pid)) {
      const cliente = sala.clientes.get(antigo.pid);
      cliente.ws = ws;
      cliente.vivoEm = Date.now();
      cliente.caiuEm = 0;
      prepararSocket(ws, cliente, sala);
      enviar(cliente, {
        t: "bemvindo",
        pid: cliente.pid,
        token: cliente.token,
        sala: sala.id,
        anfitriao: cliente.pid === sala.anfitriaoPid,
        reconectado: true,
        resumo: resumoDaSala(sala)
      });
      avisarSala(sala);
      return;
    }
  }

  // --- Escolhe a sala ---
  let sala = null;
  if (querCriar) {
    const maxPedido = inteiro(url.searchParams.get("max"), 4, MIN_JOGADORES, MAX_JOGADORES);
    const fasePedida = inteiro(url.searchParams.get("fase"), 0, 0, TOTAL_FASES - 1);
    const nomeDaSala = limpar(url.searchParams.get("salaNome"), "Sala de " + nome, 24);
    sala = criarSala(nomeDaSala, maxPedido, fasePedida, {
      clima: url.searchParams.get("clima"),
      pocaAgua: url.searchParams.get("pocaAgua"),
      pocaOleo: url.searchParams.get("pocaOleo"),
      voltas: url.searchParams.get("voltas")
    });
    if (!sala) {
      recusar(ws, "Nao foi possivel criar a sala: o servidor esta cheio.");
      return;
    }
  } else if (idPedido) {
    sala = salas.get(idPedido) || null;
    if (!sala) {
      recusar(ws, "Sala " + idPedido + " nao existe. Confira o codigo.");
      return;
    }
  } else {
    sala = salaComVaga();
    if (!sala) {
      sala = criarSala("Sala de " + nome, 4, 0, { clima: "auto", pocaAgua: true, pocaOleo: true, voltas: 3 });
      if (!sala) {
        recusar(ws, "Nao ha sala livre no momento.");
        return;
      }
    }
  }

  if (conectados(sala) >= sala.maxJogadores) {
    recusar(ws, "A sala " + sala.id + " esta cheia.");
    return;
  }
  if (sala.correndo) {
    recusar(ws, "A corrida da sala " + sala.id + " ja comecou. Tente a proxima.");
    return;
  }

  const cliente = {
    pid: novoPid(),
    token: novoToken(),
    salaId: sala.id,
    nome: nome,
    carId: carId,
    pronto: false,
    terminou: false,
    posicaoFinal: 0,
    tempoFinal: 0,
    ws: ws,
    vivoEm: Date.now(),
    caiuEm: 0,
    estadosNoSegundo: 0,
    segundoAtual: 0
  };

  sala.clientes.set(cliente.pid, cliente);
  sessoes.set(cliente.token, cliente);
  atualizarEsperaSozinha(sala);
  if (!sala.anfitriaoPid) sala.anfitriaoPid = cliente.pid;

  prepararSocket(ws, cliente, sala);

  enviar(cliente, {
    t: "bemvindo",
    pid: cliente.pid,
    token: cliente.token,
    sala: sala.id,
    anfitriao: cliente.pid === sala.anfitriaoPid,
    reconectado: false,
    resumo: resumoDaSala(sala)
  });
  avisarSala(sala);
}

function recusar(ws, mensagem) {
  try {
    ws.send(JSON.stringify({ t: "erro", mensagem: mensagem }));
    ws.close(1008, "recusado");
  } catch (e) { /* ja fechou */ }
}

function prepararSocket(ws, cliente, sala) {
  ws.on("message", function (dados, ehBinario) {
    if (ehBinario) return;
    cliente.vivoEm = Date.now();
    let msg;
    try {
      msg = JSON.parse(String(dados));
    } catch (e) {
      return;
    }
    if (!msg || typeof msg !== "object") return;
    tratarMensagem(sala, cliente, msg);
  });

  ws.on("pong", function () { cliente.vivoEm = Date.now(); });

  ws.on("close", function () {
    cliente.caiuEm = Date.now();
    // Nao tira na hora: o jogador tem RECONEXAO_MS para voltar a mesma sala.
    if (sala.clientes.has(cliente.pid)) {
      passarOAnfitriao(sala);
      atualizarEsperaSozinha(sala);
      avisarSala(sala);
    }
  });

  ws.on("error", function () { /* o close vem em seguida */ });
}

function tratarMensagem(sala, cliente, msg) {
  switch (msg.t) {

    // Estado do carro, o tipo mais comum. Vai direto para os outros da sala.
    case "estado": {
      const agora = Math.trunc(Date.now() / 1000);
      if (cliente.segundoAtual !== agora) {
        cliente.segundoAtual = agora;
        cliente.estadosNoSegundo = 0;
      }
      cliente.estadosNoSegundo++;
      if (cliente.estadosNoSegundo > ESTADOS_POR_SEGUNDO) return;

      transmitir(sala, {
        t: "estado",
        pid: cliente.pid,
        playerId: cliente.pid,
        playerName: cliente.nome,
        x: numero(msg.x, 0, -4, 4),
        position: numero(msg.position, 0, 0, 1e9),
        speed: numero(msg.speed, 0, -1e5, 1e5),
        lap: inteiro(msg.lap, 0, 0, 99),
        fuel: numero(msg.fuel, 1, 0, 1),
        carId: inteiro(msg.carId, cliente.carId, 0, 9),
        rank: inteiro(msg.rank, 1, 1, 64),
        finished: !!msg.finished
      }, cliente);
      return;
    }

    case "pronto": {
      cliente.pronto = !!msg.pronto;
      avisarSala(sala);
      return;
    }

    case "carro": {
      cliente.carId = inteiro(msg.carId, cliente.carId, 0, 9);
      avisarSala(sala);
      return;
    }

    case "nome": {
      cliente.nome = limpar(msg.nome, cliente.nome, 14);
      avisarSala(sala);
      return;
    }

    // So o anfitriao escolhe a fase — todos correm a mesma.
    case "fase": {
      if (cliente.pid !== sala.anfitriaoPid) return;
      sala.fase = inteiro(msg.fase, sala.fase, 0, TOTAL_FASES - 1);
      // Trocar a fase derruba o "pronto" de todo mundo: ninguem confirma no escuro.
      for (const outro of sala.clientes.values()) outro.pronto = false;
      avisarSala(sala);
      return;
    }

    case "maximo": {
      if (cliente.pid !== sala.anfitriaoPid) return;
      const novo = inteiro(msg.max, sala.maxJogadores, MIN_JOGADORES, MAX_JOGADORES);
      if (novo >= conectados(sala)) sala.maxJogadores = novo;
      avisarSala(sala);
      return;
    }

    // Largada: so o anfitriao, e so com gente suficiente.
    case "largar": {
      if (cliente.pid !== sala.anfitriaoPid) return;
      if (sala.correndo) return;
      if (conectados(sala) < MIN_JOGADORES) {
        enviar(cliente, { t: "erro", mensagem: "Precisa de pelo menos " + MIN_JOGADORES + " jogadores na sala." });
        return;
      }
      sala.correndo = true;
      sala.corridaId = crypto.randomBytes(8).toString("hex");
      // A semente decide a pista. Todos usam a mesma, entao correm o mesmo tracado.
      sala.semente = crypto.randomInt(1, 2147483646);
      sala.largadaEm = Date.now();
      for (const outro of sala.clientes.values()) {
        outro.terminou = false;
        outro.posicaoFinal = 0;
        outro.tempoFinal = 0;
      }
      transmitir(sala, {
        t: "largada",
        semente: sala.semente,
        fase: sala.fase,
        clima: sala.clima,
        pocaAgua: sala.pocaAgua,
        pocaOleo: sala.pocaOleo,
        voltas: sala.voltas,
        corridaId: sala.corridaId,
        // Tres segundos para todos receberem a mensagem e montarem a pista.
        // O cliente desconta metade da propria latencia, fazendo a contagem
        // regressiva terminar praticamente no mesmo instante para a sala toda.
        emMs: 3000,
        jogadores: resumoDaSala(sala).jogadores
      });
      avisarSala(sala);
      return;
    }

    case "chegou": {
      if (cliente.terminou) return;
      cliente.terminou = true;
      cliente.tempoFinal = numero(msg.tempo, 0, 0, 100000);
      // A ordem de chegada quem decide e o servidor: e a unica fonte comum.
      let jaChegaram = 0;
      for (const outro of sala.clientes.values()) if (outro.terminou) jaChegaram++;
      cliente.posicaoFinal = jaChegaram;
      transmitir(sala, {
        t: "chegou",
        pid: cliente.pid,
        nome: cliente.nome,
        posicao: cliente.posicaoFinal,
        tempo: cliente.tempoFinal
      });
      avisarSala(sala);

      // Todo mundo chegou: a sala volta para o saguao, pronta para outra corrida.
      let faltam = 0;
      for (const outro of sala.clientes.values()) {
        if (outro.ws && outro.ws.readyState === WebSocket.OPEN && !outro.terminou) faltam++;
      }
      if (faltam === 0) encerrarCorrida(sala);
      return;
    }

    // O anfitriao pode encerrar antes, se alguem travar no meio da pista.
    case "encerrar": {
      if (cliente.pid !== sala.anfitriaoPid) return;
      encerrarCorrida(sala);
      return;
    }

    // Provocacao/recado curto. E o que o Bluetooth chamava de sendRaw.
    case "conversa": {
      const texto = limpar(msg.texto, "", 60);
      if (!texto) return;
      transmitir(sala, { t: "conversa", pid: cliente.pid, nome: cliente.nome, texto: texto });
      return;
    }

    case "sair": {
      tirarDaSala(sala, cliente, "saiu");
      try { cliente.ws.close(1000, "saiu"); } catch (e) { /* ja fechou */ }
      return;
    }

    case "ping": {
      enviar(cliente, { t: "pong", stamp: msg.stamp });
      return;
    }

    default:
      return;
  }
}

function encerrarCorrida(sala) {
  if (!sala.correndo) return;
  sala.correndo = false;
  const ordem = [];
  for (const cliente of sala.clientes.values()) {
    cliente.pronto = false;
    if (cliente.terminou) {
      ordem.push({ pid: cliente.pid, nome: cliente.nome, posicao: cliente.posicaoFinal, tempo: cliente.tempoFinal });
    }
  }
  ordem.sort((a, b) => a.posicao - b.posicao);
  transmitir(sala, { t: "fim", corridaId: sala.corridaId, ordem: ordem });
  atualizarEsperaSozinha(sala);
  avisarSala(sala);
}

// ---------------------------------------------------------------------------
// Varredura: derruba socket morto, tira quem nao voltou e apaga sala sozinha
// ---------------------------------------------------------------------------

function apagarSalaInativa(sala, mensagem) {
  salas.delete(sala.id);
  for (const cliente of sala.clientes.values()) {
    sessoes.delete(cliente.token);
    enviar(cliente, {
      t: "erro",
      mensagem: mensagem
    });
    try { cliente.ws.close(1001, "sala inativa"); } catch (e) { /* ja fechou */ }
  }
  sala.clientes.clear();
}

function varrerSalas(instante) {
  const agora = Number.isFinite(instante) ? instante : Date.now();

  for (const sala of Array.from(salas.values())) {
    for (const cliente of Array.from(sala.clientes.values())) {
      const aberto = cliente.ws && cliente.ws.readyState === WebSocket.OPEN;

      if (aberto) {
        if (agora - cliente.vivoEm > BATIMENTO_MS) {
          try { cliente.ws.terminate(); } catch (e) { /* ja morreu */ }
          cliente.caiuEm = agora;
        } else {
          try { cliente.ws.ping(); } catch (e) { /* ja morreu */ }
        }
        continue;
      }

      // Caiu: espera a folga de reconexao antes de liberar a vaga.
      if (cliente.caiuEm && agora - cliente.caiuEm > RECONEXAO_MS) {
        tirarDaSala(sala, cliente, "desconectou");
      }
    }

    atualizarEsperaSozinha(sala, agora);
    if (sala.vaziaDesde && agora - sala.vaziaDesde >= SALA_VAZIA_MS) {
      apagarSalaInativa(sala, "Sala encerrada depois de ficar vazia por 2 minutos.");
    } else if (sala.sozinhaDesde && agora - sala.sozinhaDesde >= SALA_SOZINHA_MS) {
      apagarSalaInativa(sala, "Sala encerrada: nenhum outro jogador entrou em 5 minutos.");
    }
  }
}

setInterval(varrerSalas, VARREDURA_MS);

servidor.listen(PORT, HOST, function () {
  console.log("Sala online do Turbo Race ouvindo em " + HOST + ":" + PORT + " (WebSocket em " + CAMINHO_WS + ")");
});

module.exports = {
  teste: {
    salas: salas,
    sessoes: sessoes,
    varrerSalas: varrerSalas,
    salaVaziaMs: SALA_VAZIA_MS,
    salaSozinhaMs: SALA_SOZINHA_MS
  }
};
