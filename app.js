(function () {
  'use strict';

  var REQUEST_TIMEOUT_MS = 12000;
  var RETRY_COOLDOWN_MS = 3000;
  var ALIAS_KEY = 'quiz_alias';
  var ALIAS_RE = /^[a-z]{3,12}-[a-z]{3,12}-\d{2}$/;
  var BLOQUES = { T: 'Clase', CLF: 'CLF-C02', AIF: 'AIF-C01' };

  var SUSTANTIVOS = [
    'zorro', 'lince', 'puma', 'tucan', 'colibri', 'ajolote', 'jaguar', 'quetzal',
    'coyote', 'venado', 'halcon', 'buho', 'delfin', 'tortuga', 'nutria', 'tejon',
    'gavilan', 'iguana', 'mapache', 'cenzontle', 'ocelote', 'armadillo', 'pelicano', 'correcaminos'
  ];
  var ADJETIVOS = [
    'azul', 'verde', 'rojo', 'dorado', 'veloz', 'sereno', 'audaz', 'agil',
    'lunar', 'solar', 'astuto', 'noble', 'tenaz', 'curioso', 'brillante', 'tranquilo',
    'valiente', 'paciente', 'alegre', 'firme', 'ligero', 'atento', 'sabio', 'franco'
  ];

  var cfg = window.QUIZ_CONFIG || {};
  var params = new URLSearchParams(window.location.search);
  var reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  var stage = document.getElementById('stage');
  var progress = document.getElementById('progress');
  var progressFill = document.getElementById('progress-fill');
  var aliasEl = document.getElementById('alias');

  var alias = getAlias();
  var apiUrl = resolveApiUrl();
  var questions = [];
  var results = [];
  var current = null; // controlador de la pregunta visible

  aliasEl.textContent = alias;
  document.addEventListener('keydown', onKeydown);
  loadQuestions();

  /* ---------- utilidades ---------- */

  function el(tag, props) {
    var node = document.createElement(tag);
    if (props) {
      Object.keys(props).forEach(function (key) {
        var value = props[key];
        if (value === null || value === undefined || value === false) return;
        if (key === 'class') node.className = value;
        else if (key === 'text') node.textContent = value;
        else node.setAttribute(key, value === true ? '' : String(value));
      });
    }
    for (var i = 2; i < arguments.length; i++) {
      if (arguments[i]) node.appendChild(arguments[i]);
    }
    return node;
  }

  function randomInt(max) {
    try {
      var buf = new Uint32Array(1);
      window.crypto.getRandomValues(buf);
      return buf[0] % max;
    } catch (e) {
      return Math.floor(Math.random() * max);
    }
  }

  function makeAlias() {
    var nn = String(randomInt(100));
    if (nn.length < 2) nn = '0' + nn;
    return SUSTANTIVOS[randomInt(SUSTANTIVOS.length)] + '-' + ADJETIVOS[randomInt(ADJETIVOS.length)] + '-' + nn;
  }

  function getAlias() {
    try {
      var saved = window.localStorage.getItem(ALIAS_KEY);
      if (saved && ALIAS_RE.test(saved)) return saved;
    } catch (e) { /* sin almacenamiento: se usa un alias solo para esta visita */ }
    var fresh = makeAlias();
    try { window.localStorage.setItem(ALIAS_KEY, fresh); } catch (e) { /* idem */ }
    return fresh;
  }

  function resolveApiUrl() {
    var override = params.get('api');
    var raw = override || cfg.API_URL || '';
    if (!raw || (!override && /REEMPLAZA/.test(raw))) return null;
    try {
      var url = new URL(raw, window.location.href);
      if (url.protocol === 'https:' || url.protocol === 'http:') return url.href;
    } catch (e) { /* URL inválida */ }
    return null;
  }

  function intParam(name) {
    var raw = params.get(name);
    if (raw === null || !/^\d+$/.test(raw)) return null;
    return parseInt(raw, 10);
  }

  function formatTime(seconds) {
    var m = Math.floor(seconds / 60);
    var s = seconds % 60;
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  function sanitizeQuestions(data) {
    if (!Array.isArray(data)) return [];
    var list = [];
    data.forEach(function (item) {
      if (!item || typeof item.id !== 'string' || typeof item.q !== 'string') return;
      if (!Array.isArray(item.a) || item.a.length !== 4) return;
      if (!item.a.every(function (x) { return typeof x === 'string'; })) return;
      var t = Number(item.t);
      if (!isFinite(t) || t <= 0) t = 30;
      list.push({
        id: item.id,
        bloque: typeof item.bloque === 'string' ? item.bloque : '',
        q: item.q,
        a: item.a.slice(),
        t: Math.min(3600, Math.max(3, Math.round(t)))
      });
    });
    return list;
  }

  function applyRange(list) {
    var desde = intParam('desde');
    var hasta = intParam('hasta');
    var from = desde && desde >= 1 ? desde : 1;
    var to = hasta && hasta >= 1 ? hasta : list.length;
    if (from > to) return list;
    var cut = list.slice(from - 1, to);
    return cut.length ? cut : list;
  }

  /* ---------- transición entre tarjetas ---------- */

  function swapCard(card) {
    var olds = Array.prototype.slice.call(stage.children);
    var animate = !reducedMotion.matches;
    olds.forEach(function (old) {
      if (!animate || old.classList.contains('is-leaving')) {
        stage.removeChild(old);
        return;
      }
      old.classList.remove('is-entering');
      old.classList.add('is-leaving');
      old.setAttribute('aria-hidden', 'true');
      old.setAttribute('inert', '');
      var remove = function () { if (old.parentNode) old.parentNode.removeChild(old); };
      old.addEventListener('animationend', remove);
      window.setTimeout(remove, 400);
    });
    if (animate) card.classList.add('is-entering');
    stage.appendChild(card);
  }

  function setProgress(done, total) {
    progress.setAttribute('aria-valuemax', String(total));
    progress.setAttribute('aria-valuenow', String(done));
    progress.setAttribute('aria-valuetext', done + ' de ' + total + ' preguntas');
    progressFill.style.width = (total ? (done / total) * 100 : 0) + '%';
  }

  function focusQuietly(node) {
    try { node.focus({ preventScroll: true }); } catch (e) { node.focus(); }
  }

  /* ---------- carga ---------- */

  function showStatus(message, onRetry) {
    var card = el('section', { class: 'card' }, el('p', { class: 'status-line', role: 'status', text: message }));
    if (onRetry) {
      var btn = el('button', { class: 'btn btn-primary', type: 'button', text: 'Reintentar carga' });
      btn.addEventListener('click', onRetry);
      card.appendChild(el('div', { class: 'actions' }, btn));
    }
    swapCard(card);
  }

  function loadQuestions() {
    current = null;
    fetch('questions.json', { cache: 'no-store', credentials: 'omit' })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (data) {
        questions = applyRange(sanitizeQuestions(data));
        if (!questions.length) {
          showStatus('No hay preguntas disponibles en este momento. Avisa a tu docente.', loadQuestions);
          return;
        }
        results = questions.map(function () { return null; });
        showQuestion(0);
      })
      .catch(function () {
        showStatus('No se pudieron cargar las preguntas. Revisa tu conexión e inténtalo de nuevo.', loadQuestions);
      });
  }

  /* ---------- envío ---------- */

  function sendAnswer(question, option) {
    if (!apiUrl) return Promise.resolve({ status: -1 });
    var controller = new AbortController();
    var timeoutId = window.setTimeout(function () { controller.abort(); }, REQUEST_TIMEOUT_MS);
    return fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': String(cfg.API_KEY || '') },
      body: JSON.stringify({ pregunta_id: question.id, opcion: option, alias: alias }),
      signal: controller.signal,
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer'
    })
      .then(function (res) {
        return res.json().catch(function () { return null; }).then(function (data) {
          return { status: res.status, data: data };
        });
      })
      .catch(function () { return { status: 0 }; })
      .then(function (out) {
        window.clearTimeout(timeoutId);
        return out;
      });
  }

  /* ---------- pregunta ---------- */

  function showQuestion(index) {
    var q = questions[index];
    var total = questions.length;
    var isLast = index === total - 1;
    var state = 'open'; // open | sending | retry | done
    var chosen = 0;
    var timerId = 0;
    var lastShown = -1;
    var deadline = 0;

    setProgress(index, total);

    var timerNum = el('span', { class: 'timer-num' });
    var timerFill = el('div', { class: 'timer-fill' });
    var timer = el('div', { class: 'timer', role: 'timer', 'aria-label': 'Tiempo restante' },
      el('span', { class: 'timer-label', text: 'Tiempo' }),
      timerNum,
      el('div', { class: 'timer-track', 'aria-hidden': 'true' }, timerFill));
    var srNote = el('p', { class: 'sr-only', 'aria-live': 'polite' });

    var heading = el('h1', { class: 'question', tabindex: '-1', text: q.q });
    var list = el('ol', { class: 'options' });
    var buttons = q.a.map(function (text, i) {
      var n = i + 1;
      var stateEl = el('span', { class: 'option-state' });
      var btn = el('button', { class: 'option', type: 'button', 'aria-keyshortcuts': String(n) },
        el('span', { class: 'option-key', text: String(n) }),
        el('span', { class: 'option-label', text: text }),
        stateEl);
      btn.addEventListener('click', function () { choose(n); });
      list.appendChild(el('li', null, btn));
      return { btn: btn, stateEl: stateEl };
    });

    var result = el('div', { class: 'result', 'aria-live': 'polite' });
    var retryBtn = el('button', { class: 'btn', type: 'button', text: 'Reintentar envío', hidden: true });
    var nextBtn = el('button', { class: 'btn btn-primary', type: 'button', hidden: true });
    retryBtn.addEventListener('click', function () { if (state === 'retry') submit(); });
    nextBtn.addEventListener('click', next);
    var actions = el('div', { class: 'actions', hidden: true }, nextBtn, retryBtn);

    var card = el('section', { class: 'card', 'aria-label': 'Pregunta ' + (index + 1) + ' de ' + total },
      el('div', { class: 'meta' },
        el('span', { class: 'count', text: 'Pregunta ' + (index + 1) + ' de ' + total }),
        q.bloque ? el('span', { class: 'badge', text: BLOQUES[q.bloque] || q.bloque }) : null),
      timer, srNote, heading, list, result,
      actions);

    swapCard(card);
    focusQuietly(heading);
    current = { choose: choose };

    deadline = performance.now() + q.t * 1000;
    tick();
    timerId = window.setInterval(tick, 250);

    function tick() {
      var left = Math.max(0, deadline - performance.now());
      var secs = Math.ceil(left / 1000);
      if (secs !== lastShown) {
        lastShown = secs;
        timerNum.textContent = formatTime(secs);
        if (secs <= 5) timer.classList.add('is-low');
        if (secs === 10 && q.t > 10) srNote.textContent = 'Quedan 10 segundos.';
      }
      timerFill.style.transform = 'scaleX(' + (left / (q.t * 1000)).toFixed(4) + ')';
      if (left <= 0) onTimeout();
    }

    function stopTimer() {
      window.clearInterval(timerId);
      timer.classList.add('is-stopped');
    }

    function lockOptions() {
      buttons.forEach(function (b) { b.btn.disabled = true; });
    }

    function setResult(kind, title, body) {
      var icons = { ok: '✓', bad: '✕', warn: '!', info: 'i' };
      var box = el('div', { class: 'result-box is-' + kind },
        el('p', { class: 'result-title' },
          el('span', { class: 'result-icon', 'aria-hidden': 'true', text: icons[kind] }),
          el('span', { text: title })),
        body ? el('p', { class: 'result-body', text: body }) : null);
      result.replaceChildren(box);
    }

    function showActions(canRetry, cooldown) {
      nextBtn.textContent = canRetry
        ? (isLast ? 'Terminar sin registrar' : 'Continuar sin registrar')
        : (isLast ? 'Ver resultados' : 'Siguiente pregunta');
      actions.hidden = false;
      nextBtn.hidden = false;
      retryBtn.hidden = !canRetry;
      if (canRetry && cooldown) {
        retryBtn.disabled = true;
        window.setTimeout(function () { retryBtn.disabled = false; }, RETRY_COOLDOWN_MS);
      } else {
        retryBtn.disabled = false;
      }
      focusQuietly(canRetry && !cooldown ? retryBtn : nextBtn);
    }

    function onTimeout() {
      if (state !== 'open') return;
      state = 'done';
      stopTimer();
      lockOptions();
      results[index] = 'timeout';
      setResult('warn', 'Se acabó el tiempo', 'Esta pregunta quedó sin respuesta y no se envió nada.');
      showActions(false);
    }

    function choose(n) {
      if (state !== 'open' || n < 1 || n > 4) return;
      chosen = n;
      stopTimer();
      lockOptions();
      buttons[n - 1].btn.classList.add('is-selected');
      submit();
    }

    function submit() {
      state = 'sending';
      actions.hidden = true;
      nextBtn.hidden = true;
      retryBtn.hidden = true;
      buttons[chosen - 1].stateEl.textContent = 'Enviando…';
      setResult('info', 'Enviando tu respuesta…');
      sendAnswer(q, chosen).then(handleResponse);
    }

    function finish(outcome, kind, title, body, stateText) {
      state = 'done';
      results[index] = outcome;
      buttons[chosen - 1].stateEl.textContent = stateText || 'Tu respuesta';
      setResult(kind, title, body);
      showActions(false);
    }

    function offerRetry(kind, title, body, cooldown) {
      state = 'retry';
      results[index] = 'error';
      buttons[chosen - 1].stateEl.textContent = 'Sin registrar';
      setResult(kind, title, body);
      showActions(true, cooldown);
    }

    function handleResponse(res) {
      if (current === null || current.choose !== choose) return;
      var data = res.data && typeof res.data === 'object' ? res.data : {};
      var serverError = typeof data.error === 'string' && data.error ? data.error : '';

      if (res.status === 200 && typeof data.acierto === 'boolean') {
        var correcta = Number(data.correcta);
        var explicacion = typeof data.explicacion === 'string' ? data.explicacion : '';
        var mine = buttons[chosen - 1];
        mine.btn.classList.remove('is-selected');
        if (data.acierto) {
          mine.btn.classList.add('is-correct', 'is-pulse');
          finish('ok', 'ok', 'Correcto', explicacion, '✓ Correcta');
        } else {
          mine.btn.classList.add('is-wrong');
          if (correcta >= 1 && correcta <= 4 && correcta !== chosen) {
            var right = buttons[correcta - 1];
            right.btn.classList.add('is-correct', 'is-pulse');
            right.stateEl.textContent = '✓ Correcta';
          }
          finish('bad', 'bad', 'Incorrecto', explicacion, '✕ Tu respuesta');
        }
        return;
      }

      switch (res.status) {
        case 202:
          finish('queued', 'info', 'Respuesta recibida, en cola',
            'Tu respuesta se registró y se calificará en unos momentos. Puedes continuar.', 'En cola');
          break;
        case 400:
          finish('error', 'warn', 'No se pudo registrar la respuesta',
            serverError ? 'El servicio indicó: ' + serverError : 'El servicio rechazó la solicitud. Avisa a tu docente.',
            'Sin registrar');
          break;
        case 403:
          finish('error', 'warn', 'Llave de acceso inválida',
            'El servicio no aceptó la llave configurada. Avisa a tu docente; mientras tanto puedes continuar.',
            'Sin registrar');
          break;
        case 409:
          finish('dup', 'info', 'Esta pregunta ya estaba respondida',
            'Se conserva la primera respuesta registrada con tu alias.', 'Ya respondida');
          break;
        case 429:
          offerRetry('warn', 'Demasiadas solicitudes',
            'El servicio está recibiendo muchas respuestas. Espera unos segundos y reintenta.', true);
          break;
        case -1:
          finish('error', 'warn', 'Falta configurar el servicio',
            'Esta página todavía no tiene una dirección de API válida (config.js). Avisa a tu docente.',
            'Sin registrar');
          break;
        case 0:
          offerRetry('warn', 'Sin conexión con el servicio',
            'No se pudo enviar tu respuesta. Revisa tu conexión a internet y reintenta.', false);
          break;
        default:
          offerRetry('warn', 'El servicio no respondió como se esperaba',
            'Código ' + res.status + '. Reintenta en unos segundos.', false);
      }
    }

    function next() {
      if (state !== 'done' && state !== 'retry') return;
      state = 'left';
      window.clearInterval(timerId);
      if (isLast) showFinal();
      else showQuestion(index + 1);
    }
  }

  function onKeydown(event) {
    if (!current || event.ctrlKey || event.metaKey || event.altKey || event.repeat) return;
    if (event.key >= '1' && event.key <= '4' && event.key.length === 1) {
      event.preventDefault();
      current.choose(Number(event.key));
    }
  }

  /* ---------- pantalla final ---------- */

  function showFinal() {
    current = null;
    var total = questions.length;
    var count = function (kind) {
      return results.filter(function (r) { return r === kind; }).length;
    };
    var ok = count('ok');
    var bad = count('bad');
    var queued = count('queued');
    var dup = count('dup');
    var timeouts = count('timeout');
    var errors = count('error');
    var graded = ok + bad;

    setProgress(total, total);

    var message;
    if (!graded) {
      message = queued || dup
        ? 'Tus respuestas quedaron registradas; la calificación la verás con tu docente.'
        : 'No se calificó ninguna respuesta en esta visita.';
    } else if (ok / total >= 0.9) {
      message = '¡Excelente! Dominas el tema.';
    } else if (ok / total >= 0.7) {
      message = 'Buen trabajo. Repasa las que fallaste y quedas listo.';
    } else if (ok / total >= 0.5) {
      message = 'Vas a la mitad del camino. Revisa las explicaciones y vuelve a los temas débiles.';
    } else {
      message = 'Hay terreno por repasar. Las explicaciones de cada pregunta son un buen punto de partida.';
    }

    var notes = el('ul', { class: 'final-notes' });
    var addNote = function (n, singular, plural) {
      if (n) notes.appendChild(el('li', { text: n + ' ' + (n === 1 ? singular : plural) }));
    };
    addNote(queued, 'respuesta en cola, pendiente de calificar', 'respuestas en cola, pendientes de calificar');
    addNote(dup, 'pregunta ya estaba respondida', 'preguntas ya estaban respondidas');
    addNote(timeouts, 'pregunta sin respuesta por tiempo', 'preguntas sin respuesta por tiempo');
    addNote(errors, 'respuesta no se pudo registrar', 'respuestas no se pudieron registrar');

    var MARKS = {
      ok: ['✓', 'is-ok', 'correcta'],
      bad: ['✕', 'is-bad', 'incorrecta'],
      queued: ['…', '', 'en cola'],
      dup: ['=', '', 'ya respondida'],
      timeout: ['–', 'is-warn', 'sin respuesta'],
      error: ['!', 'is-warn', 'sin registrar']
    };
    var marks = el('ol', { class: 'marks', 'aria-label': 'Detalle por pregunta' });
    results.forEach(function (r, i) {
      var m = MARKS[r] || MARKS.error;
      marks.appendChild(el('li', { class: 'mark ' + m[1] },
        el('span', { 'aria-hidden': 'true', text: (i + 1) + ' ' + m[0] }),
        el('span', { class: 'sr-only', text: 'Pregunta ' + (i + 1) + ': ' + m[2] })));
    });

    var title = el('h1', { class: 'final-title', tabindex: '-1', text: 'Terminaste el quiz' });
    var score = el('p', { class: 'score' },
      el('span', { text: String(ok) }),
      el('span', { class: 'score-total', text: ' de ' + total + (total === 1 ? ' acierto' : ' aciertos') }));

    var card = el('section', { class: 'card', 'aria-label': 'Resultados' },
      title, score,
      el('p', { class: 'final-msg', text: message }),
      notes.childNodes.length ? notes : null,
      marks,
      el('ul', { class: 'final-notes' }, el('li', { text: 'Alias con el que se registraron tus respuestas: ' + alias })));

    swapCard(card);
    focusQuietly(title);
  }
})();
