/*
 * Client side of the mock participant page. It reproduces how the real Poll
 * Everywhere participant page behaves, as read from that site's own scripts:
 * element and class names, status texts, optimistic updates, the "result" and
 * "notification:show" events, and the delay before earlier responses load.
 * Nothing here is Poll Everywhere's code.
 */
(() => {
  const presenter = document.body.dataset.presenter;
  const MC = 'component-response-multiple-choice';
  const OE = 'component-response-open-ended';
  const HEADER = 'component-response-header';

  const esc = (text) =>
    String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const el = (html) => {
    const template = document.createElement('template');
    template.innerHTML = html.trim();
    return template.content.firstElementChild;
  };
  const plural = (n, word) => (n === 1 ? word : `${word}s`);

  // Live updates for a mounted poll (lock, unlock, cleared responses, edits).
  const liveListeners = new Map();

  // ---------------------------------------------------------------- state rules

  function isEnabled(poll, results) {
    const pending = results.some((r) => r.isPending);
    const open = poll.state === 'opened';
    const underLimit = !poll.max_votes || results.length < poll.max_votes;
    return Boolean(poll.web_enabled) && open && underLimit && !pending;
  }

  function statusMessage(poll, results) {
    if (!poll.web_enabled) return 'Web Voting has not been turned on for this poll.';
    if (poll.state === 'closed') return '<span></span>This poll is locked.';
    if (poll.state === 'maxed_out') return 'Poll is full. This poll has received the maximum number of responses allowed.';
    const count = results.length;
    const max = poll.max_votes || 0;
    if (max && count >= max) {
      return max === 1 ? 'Response recorded' : 'You have responded the maximum number of times to this poll';
    }
    if (poll.type === 'ranking_poll') return 'Tap an answer you want to move, then submit your response';
    if (max === 1) return 'You can respond once';
    const perOption = poll.type === 'multiple_choice_poll' && poll.responses_per_option;
    const suffix = perOption
      ? `. Each option may only be selected ${poll.responses_per_option === 1 ? 'once' : `${poll.responses_per_option} times`}.`
      : '';
    if (count === 0) return (max ? `You can respond ${max} times` : 'You have not responded') + suffix;
    if (max) {
      const left = max - count;
      return `You have ${left} ${plural(left, 'response')} remaining${suffix}`;
    }
    return `You have responded ${count === 1 ? 'once' : `${count} times`}${suffix}`;
  }

  // ---------------------------------------------------------------- the activity view

  function createView(data, host) {
    const poll = { ...data.activity };
    const hasId = !poll.skeleton_ms;
    let results = [];
    let removed = false;
    let bodyDrawn = false;

    const root = document.createElement('div');
    root.className = 'component-response-activity';
    // A competition question carries the question's own type, as on the real page.
    root.setAttribute('data-activity-type', poll.type === 'competition' && poll.display_state === 'instructions' ? 'multiple_choice_poll' : poll.type);

    const model = {
      get id() {
        return hasIdNow() ? poll.id : undefined;
      },
      get: (key) => poll[key],
      results: {
        get models() {
          return results.map((r) => ({ id: r.id, has: (key) => r[key] !== undefined }));
        },
      },
    };
    let idReady = hasId;
    function hasIdNow() {
      return idReady;
    }

    const typeClass =
      {
        multiple_choice_poll: MC,
        free_text_poll: OE,
        ranking_poll: 'component-response-rank-order',
        clickable_image: 'component-response-clickable-image',
        discourse: 'component-response-qa',
        survey: 'component-response-survey',
        competition: 'component-response-competition',
      }[poll.type] || 'component-response-unknown';

    const typeRoot = document.createElement('div');
    typeRoot.className = typeClass;
    root.appendChild(typeRoot);

    const header = el(`<div class="${HEADER}" tabindex="-1">
      <h1 class="${HEADER}__title"></h1>
      <span class="${HEADER}__aria-desc" hidden></span>
      <div class="${HEADER}__look-at-screen"><p>Look at the screen</p></div>
      <div class="${HEADER}__status"></div>
      <div class="${HEADER}__anonymous"></div>
    </div>`);
    const titleEl = header.querySelector(`.${HEADER}__title`);
    const statusEl = header.querySelector(`.${HEADER}__status`);

    const dispatch = (name, detail) => root.dispatchEvent(new CustomEvent(name, { bubbles: true, detail }));

    const api = `/api/polls/${encodeURIComponent(poll.id)}/results`;

    function fetchResults() {
      if (poll.no_restore) return;
      fetch(api, { credentials: 'same-origin' })
        .then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.json();
        })
        .then((list) => {
          if (removed) return;
          // Like the real page: the fetched list replaces the local one, unsaved entries included.
          results = Array.isArray(list) ? list.map((r) => ({ ...r })) : [];
          countUpdate();
          update();
        })
        .catch(() => undefined);
    }

    // The real page adds the local response count to the poll's count on every change
    // to the participant's responses (undefined stays undefined: NaN).
    function countUpdate() {
      if (poll.type !== 'competition') poll.results_count = poll.results_count + results.length;
    }

    function save(result, body) {
      result.isPending = true;
      countUpdate();
      update();
      fetch(api, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...body, source: 'pollev_page', isPending: true }),
      })
        .then(async (response) => {
          let json = null;
          try {
            json = await response.json();
          } catch {
            // As on the real page (which expects JSON), a reply that cannot be read is a failure.
            if (response.ok) throw new Error('unreadable reply');
          }
          if (!response.ok) throw json;
          if (removed) return;
          delete result.isPending;
          result.id = json && json.id;
          update();
          dispatch('result', { results: [result] });
        })
        .catch((problem) => {
          if (removed) return;
          delete result.isPending;
          results = results.filter((r) => r !== result);
          countUpdate();
          update();
          // As on the real page: a JSON reply without an "error" object makes the page's
          // own error handling throw, so no error event is raised at all. A network
          // failure or a reply that is not JSON is reported as an unknown error.
          let content;
          if (problem instanceof Error || problem === null || problem === undefined) {
            content = 'An unknown error has occurred\r\n- undefined';
          } else if (typeof problem === 'object' && !('error' in problem)) {
            return;
          } else {
            const lines = [problem.error.message];
            (problem.error.detail || []).forEach((d) => lines.push(`- ${d.message}`));
            content = lines.join('\r\n');
          }
          dispatch('notification:show', { type: 'error', title: 'Error', content });
        });
    }

    // ------------------------------------------------------------ multiple choice

    let optionViews = [];
    let listEl = null;

    // Option text as drawn: equations show a placeholder until their script loads.
    let equationsReady = !poll.equation_ms;
    function optionHtml(option) {
      if (!equationsReady) return '<span class="latex--container value" data-rendered="false">[<em>loading eqn.</em>]</span>';
      return esc(option.value);
    }

    function drawOptions() {
      if (!listEl) return;
      // Options are kept by id, as on the real page: an edit changes text in place.
      const keep = new Map(optionViews.map((view) => [view.option.id, view]));
      const next = (poll.options || []).map((option) => {
        const existing = keep.get(option.id);
        if (existing) {
          existing.option = option;
          existing.wrapper.querySelector(`.${MC}__option__value`).innerHTML = optionHtml(option);
          keep.delete(option.id);
          return existing;
        }
        const wrapper = document.createElement('div');
        wrapper.className = `${MC}__option`;
        wrapper.innerHTML = `<button class="${MC}__option__vote">
          <div class="${MC}__option__results-count">0</div>
          <div class="${MC}__option__value"></div>
        </button>
        <button class="${MC}__option__undo" title="Undo vote" hidden>↶</button>`;
        const vote = wrapper.querySelector(`.${MC}__option__vote`);
        wrapper.querySelector(`.${MC}__option__value`).innerHTML = optionHtml(option);
        const view = { option, wrapper, vote, count: wrapper.querySelector(`.${MC}__option__results-count`) };
        // No enabled-check here, as on the real page: a disabled button simply does not fire.
        vote.addEventListener('click', () => {
          const result = { option_id: view.option.id };
          results.push(result);
          save(result, { option_id: view.option.id });
        });
        return view;
      });
      for (const gone of keep.values()) gone.wrapper.remove();
      for (const view of next) listEl.appendChild(view.wrapper);
      optionViews = next;
      const n = optionViews.length;
      listEl.setAttribute('aria-label', `Response options, ${n} ${plural(n, 'option')}`);
    }

    function drawMultipleChoiceBody(container) {
      const body = el(`<div class="${MC}__body">
        <div class="${MC}__instruction-image ${MC}__instruction-image--hidden"><img src="" alt=""></div>
        <div class="${MC}__response-container">
          <button class="${MC}__undo" style="display: none">Clear last response</button>
        </div>
      </div>`);
      listEl = el(`<div class="component-list ${MC}__response-options"></div>`);
      body.querySelector(`.${MC}__response-container`).prepend(listEl);
      container.appendChild(body);
      drawOptions();
    }

    // ------------------------------------------------------------ open ended

    let textarea = null;
    let submit = null;
    let responsesEl = null;
    let placeholderEl = null;
    let responseList = null;

    function drawOpenEndedBody(container, { showResponses, maxLength }) {
      const body = el(`<div class="${OE}__body">
        <div class="${OE}__instruction-image ${OE}__instruction-image--hidden"><img src="" alt=""></div>
        <form method="post" novalidate action="#">
          <div class="${OE}__input" aria-label="Please enter your response">
            <textarea name="response" placeholder="Type here..."></textarea>
          </div>
          <input type="submit" value="Submit">
        </form>
        <div class="${OE}__responses" role="log" aria-label="Your responses">
          <div class="${OE}__response-placeholder">No responses submitted yet.</div>
        </div>
      </div>`);
      textarea = body.querySelector('textarea');
      textarea.setAttribute('maxlength', String(maxLength));
      submit = body.querySelector('input[type=submit]');
      responsesEl = body.querySelector(`.${OE}__responses`);
      placeholderEl = body.querySelector(`.${OE}__response-placeholder`);
      if (showResponses) {
        responseList = el('<div class="component-list"></div>');
        responsesEl.appendChild(responseList);
      } else {
        responsesEl.remove();
        responsesEl = null;
        placeholderEl = null;
      }
      const send = () => {
        const text = textarea.value.trim();
        if (textarea.disabled || text.length === 0) return;
        textarea.value = '';
        const result = { value: text };
        results.unshift(result);
        save(result, { value: text });
      };
      body.querySelector('form').addEventListener('submit', (event) => {
        event.preventDefault();
        send();
      });
      textarea.addEventListener('keydown', (event) => {
        // The real page tests the legacy "which" property, so only a real key press submits.
        if (event.which === 13) {
          event.preventDefault();
          send();
        }
      });
      // Submit only becomes usable after a real input event, as on the real page.
      textarea.addEventListener('input', () => updateOpenEnded());
      container.appendChild(body);
    }

    function updateOpenEnded() {
      if (!textarea) return;
      const enabled = isEnabled(poll, results);
      submit.disabled = textarea.value.length === 0 || !enabled;
      textarea.disabled = !enabled;
      if (responseList) {
        responseList.innerHTML = '';
        results.forEach((result) => {
          responseList.appendChild(
            el(`<div class="${OE}__result"><span class="${OE}__result__value">${esc(result.value)}</span>
              <button class="${OE}__result__undo" title="Clear response" hidden>×</button></div>`),
          );
        });
      }
      if (placeholderEl) placeholderEl.style.display = results.length === 0 ? '' : 'none';
    }

    // ------------------------------------------------------------ shared

    function update() {
      if (removed || !bodyDrawn) return;
      header.classList.toggle(`${HEADER}--title-hidden`, Boolean(poll.title_hidden));
      titleEl.innerHTML = poll.title_hidden ? 'Activity title hidden' : esc(poll.title);
      const message = statusMessage(poll, results);
      statusEl.setAttribute('aria-live', 'polite');
      statusEl.innerHTML = message;
      statusEl.style.display = message.length > 0 ? '' : 'none';

      const enabled = isEnabled(poll, results);
      const pending = results.some((r) => r.isPending);
      const last = results[results.length - 1];
      optionViews.forEach((view, index) => {
        const mine = results.filter((r) => r.option_id === view.option.id).length;
        view.count.textContent = String(mine);
        view.count.hidden = poll.max_votes === 1;
        if (mine > 0) view.wrapper.setAttribute('data-vote-count', String(mine));
        else view.wrapper.removeAttribute('data-vote-count');
        view.wrapper.classList.toggle(`${MC}__option--vote`, mine > 0);
        view.wrapper.classList.toggle(`${MC}__option--last-vote`, Boolean(last) && last.option_id === view.option.id);
        const votes = mine === 1 ? 'your vote' : `${mine} of your votes`;
        view.vote.setAttribute('aria-label', `${view.option.value} with ${votes}, option ${index + 1} of ${optionViews.length}`);
        const perOptionFull = Boolean(poll.responses_per_option) && mine >= poll.responses_per_option;
        view.vote.disabled = !enabled || perOptionFull;
        const undo = view.wrapper.querySelector(`.${MC}__option__undo`);
        const willBeUndoable = poll.web_enabled && poll.state === 'opened' && poll.editable_answers && results.length > 0;
        const undoable = willBeUndoable && !pending;
        undo.disabled = mine >= 1 && willBeUndoable && !undoable;
        undo.hidden = !(mine >= 1 && willBeUndoable);
      });
      updateOpenEnded();
    }

    function drawBody() {
      if (bodyDrawn || removed) return;
      bodyDrawn = true;
      switch (poll.type) {
        case 'multiple_choice_poll':
          drawMultipleChoiceBody(typeRoot);
          break;
        case 'free_text_poll':
          drawOpenEndedBody(typeRoot, { showResponses: true, maxLength: 8000 });
          break;
        case 'discourse': {
          // Q&A embeds the open-ended form, without the "Your responses" log.
          const inner = document.createElement('div');
          inner.className = OE;
          typeRoot.appendChild(inner);
          drawOpenEndedBody(inner, { showResponses: false, maxLength: 300 });
          typeRoot.appendChild(
            el(`<div class="component-response-qa__response-list">
              <div class="component-response-qa__sort element-segmented-control">
                <label><input type="radio" name="qa-sort" value="recent" checked><span>New</span></label>
                <label><input type="radio" name="qa-sort" value="netVotesRecentFirst"><span>Top</span></label>
              </div>
              <button class="component-response-qa__load-more" disabled>Waiting for responses...</button>
              <div class="component-list" role="list"></div>
            </div>`),
          );
          break;
        }
        case 'ranking_poll':
          typeRoot.appendChild(
            el(`<div class="component-response-rank-order__body">
              <div class="component-response-rank-order__response-container">
                <div class="component-list component-response-rank-order__options">
                  ${(poll.options || [])
                    .map(
                      (o) => `<div class="component-response-rank-order__option" tabindex="0" role="row">
                    <div class="component-response-rank-order__option__actions">
                      <button class="component-response-rank-order__option__up" type="button" title="Move up">↑</button>
                      <button class="component-response-rank-order__option__down" type="button" title="Move down">↓</button>
                    </div><div class="component-response-rank-order__option__value">${esc(o.value)}</div></div>`,
                    )
                    .join('')}
                </div>
              </div>
              <button type="submit">Submit response</button>
            </div>`),
          );
          break;
        case 'clickable_image':
          typeRoot.appendChild(
            el(`<div class="component-response-clickable-image__regions">
              <img class="component-response-clickable-image__image" alt="Clickable image" width="300" height="200"
                src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='300' height='200'%3E%3Crect width='300' height='200' fill='%23ccd'/%3E%3C/svg%3E">
            </div>`),
          );
          break;
        case 'survey':
          typeRoot.appendChild(
            el(`<div class="component-response-survey__intro">
              <h1 class="component-response-survey__intro__title">${esc(poll.title)}</h1>
              <div class="component-response-survey__intro__message">2 questions</div>
              <button type="submit">Start survey</button>
            </div>`),
          );
          break;
        case 'competition':
          typeRoot.appendChild(el('<div class="component-response-competition__screen-name"></div>'));
          if (poll.display_state === 'instructions') {
            const inner = document.createElement('div');
            inner.className = MC;
            inner.appendChild(header);
            typeRoot.appendChild(inner);
            drawMultipleChoiceBody(inner);
          } else {
            typeRoot.appendChild(
              el(`<div class="component-response-competition__welcome">
                <div class="component-response-competition__welcome__title">${esc(poll.title)}</div>
                <div class="component-response-competition__welcome__subtitle">3 questions</div>
              </div>`),
            );
          }
          break;
        default:
          break;
      }
      update();
      fetchResults();
      if (!equationsReady) {
        setTimeout(() => {
          equationsReady = true;
          drawOptions();
          update();
        }, poll.equation_ms);
      }
    }

    // The header is always drawn first. With a skeleton delay the title and controls come later.
    if (poll.type !== 'survey' && !(poll.type === 'competition')) {
      (poll.type === 'discourse' ? typeRoot : typeRoot).prepend(header);
    }
    if (hasId) {
      drawBody();
    } else {
      setTimeout(() => {
        idReady = true;
        drawBody();
      }, poll.skeleton_ms);
    }

    const onLive = (message) => {
      if (removed) return;
      if ('state' in message) poll.state = message.state;
      if ('title' in message) poll.title = message.title;
      if ('options' in message) {
        poll.options = message.options;
        drawOptions();
      }
      if ('results_count' in message) {
        const previous = poll.results_count;
        poll.results_count = message.results_count;
        if (message.results_count === 0) {
          // As on the real page: free text drops the participant's responses whenever the
          // count is 0; multiple choice only when the count was above 0 before.
          if (poll.type === 'free_text_poll' || previous > 0) {
            results = [];
            countUpdate();
          }
        }
      }
      update();
    };
    liveListeners.set(poll.id, onLive);

    return {
      el: root,
      model,
      remove() {
        removed = true;
        if (liveListeners.get(poll.id) === onLive) liveListeners.delete(poll.id);
        root.remove();
      },
    };
  }

  class LegacyResponseView extends HTMLElement {
    setup(data) {
      this.cleanup();
      if (!data || !data.activity) return;
      this.responseView = createView(data, this);
      this.appendChild(this.responseView.el);
    }
    disconnectedCallback() {
      this.cleanup();
    }
    cleanup() {
      if (this.responseView) {
        this.responseView.remove();
        this.responseView = null;
      }
    }
  }
  customElements.define('legacy-response-view', LegacyResponseView);
  window.LegacyResponseView = LegacyResponseView;

  // ---------------------------------------------------------------- notifications

  const manager = document.querySelector('notification-manager');
  if (manager && manager.parentElement) {
    manager.parentElement.addEventListener('notification:show', (event) => {
      const detail = event.detail || {};
      manager.innerHTML = '';
      const role = detail.type === 'error' || detail.type === 'warning' ? 'alert' : 'status';
      const note = el(`<pe-notification type="${esc(detail.type)}"><aside class="pe-notification pe-notification--${esc(detail.type)}" role="${role}" aria-label="${esc(detail.type)}">
        <div class="pe-notification__title">${esc(String(detail.title || '').slice(0, 32))}</div>
        <p class="pe-notification__content">${esc(String(detail.content || '').slice(0, 128))}</p>
        <button name="dismiss" aria-label="Dismiss" class="pe-button__button"><span class="pe-button__label">Dismiss</span></button>
      </aside></pe-notification>`);
      note.querySelector('button').addEventListener('click', () => note.remove());
      manager.appendChild(note);
    });
  }

  // ---------------------------------------------------------------- activation

  const outer = document.getElementById('active_tab_content');
  const presenterFrameHtml = `<turbo-frame id="participate_presenter_${presenter}" src=""></turbo-frame>`;
  const waitingHtml = `<div class="waiting"><div><img alt="Placeholder logo" width="160" height="120"
      src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='120'%3E%3Crect width='160' height='120' fill='%23def'/%3E%3C/svg%3E"></div>
    <div><h1>Waiting for ${esc(presenter)}'s presentation to begin...</h1>
    <p>${esc(presenter)}'s presentation is underway. As soon as the activity is active, you’ll see it on the screen here. Stay put.</p>
    <p>This is a mock of a live polling page.</p></div></div>`;
  let currentActivity = window.__mockInitialActivity;
  let liveTab = true;

  function innerFrame() {
    return document.getElementById(`participate_presenter_${presenter}`);
  }

  function show(activity, forceFresh) {
    currentActivity = activity;
    const tab = document.getElementById('presenter_bar_current_tab');
    if (tab) tab.textContent = activity ? 'Live' : 'Waiting…';
    if (!liveTab) return;
    const frame = innerFrame();
    if (!frame) return;
    if (!activity) {
      frame.innerHTML =
        document.body.dataset.unknownWidget === 'true'
          ? '<div class="brand-new-widget"><h1>Spin the wheel</h1><button type="button" id="spin">Spin</button></div>'
          : waitingHtml;
      return;
    }
    const existing = frame.querySelector('legacy-response-view');
    const mount = (view) => {
      const run = () => {
        if (!view.isConnected) return;
        view.setup({ activity, user: {}, registrationInfo: {}, participant: { id: 1 } });
        if (activity.push_state_ms) {
          setTimeout(() => window.history.pushState({}, '', `${window.location.pathname}#poll`), activity.push_state_ms);
        }
      };
      if (activity.mount_delay_ms) setTimeout(run, activity.mount_delay_ms);
      else run();
    };
    if (existing && activity.reuse_mount && !forceFresh) {
      mount(existing);
      return;
    }
    frame.innerHTML = '';
    const view = document.createElement('legacy-response-view');
    frame.appendChild(view);
    mount(view);
  }

  // ---------------------------------------------------------------- tabs

  document.querySelectorAll('[role="tablist"] form').forEach((form) => {
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const button = form.querySelector('button');
      const toLive = button.dataset.tab === 'current';
      liveTab = toLive;
      document.querySelector('[data-tab="current"]').setAttribute('aria-selected', String(toLive));
      document.querySelector('[data-tab="pinned"]').setAttribute('aria-selected', String(!toLive));
      if (toLive) {
        outer.innerHTML = presenterFrameHtml;
        show(currentActivity, true);
      } else {
        outer.innerHTML = '<turbo-frame id="participate_pinned_user_1" src=""><p>Nothing pinned</p></turbo-frame>';
      }
    });
  });

  // ---------------------------------------------------------------- cookie banner

  document.querySelectorAll('#cookie-consent-banner button').forEach((button) => {
    button.addEventListener('click', () => {
      const region = button.closest('[role="region"]');
      if (region) region.remove();
    });
  });

  // ---------------------------------------------------------------- location check-in

  // "Check in" asks the browser for the location and sends it; the panel closes once
  // the server accepts it, and "We were unable to check you in." shows when it does not.
  const failedNote = document.getElementById('check-in-failed');
  const closeCheckIn = () => {
    const modal = document.getElementById('check-in-modal');
    if (modal) modal.remove();
  };
  const sendCheckIn = (fields) => {
    fetch(`/pollev/${encodeURIComponent(presenter)}/check_in`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(fields),
    })
      .then((r) => r.json())
      .then((reply) => {
        if (reply.accepted) {
          failedNote.hidden = true;
          closeCheckIn();
        } else {
          failedNote.hidden = false;
        }
      })
      .catch(() => {
        failedNote.hidden = false;
      });
  };
  document.addEventListener('click', (event) => {
    const button = event.target instanceof Element ? event.target.closest('[data-check-in]') : null;
    if (!button) return;
    if (button.dataset.checkIn === 'skip') {
      closeCheckIn();
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) =>
        sendCheckIn({ latitude: position.coords.latitude, longitude: position.coords.longitude, accuracy: position.coords.accuracy }),
      (error) => sendCheckIn({ error: error.message || 'unavailable' }),
      { timeout: 5000 },
    );
  });

  // ---------------------------------------------------------------- push channel

  // As on the real page, the element carries a channel object whose state is the
  // truth. When the connection drops and is being re-established, the "connected"
  // attribute stays set (the real client keeps it during a recoverable drop).
  const source = document.querySelector('turbo-cable-stream-source');
  source.channel = { state: 'connecting' };
  // Like the real page, ask for whatever was pushed since this page was rendered.
  const events = new EventSource(`/pollev/${encodeURIComponent(presenter)}/events?since=${window.__mockRenderedAt || 0}`);
  events.onopen = () => {
    source.channel.state = 'connected';
    source.setAttribute('connected', '');
  };
  events.onerror = () => {
    source.channel.state = 'connecting';
  };
  events.addEventListener('activation', (event) => {
    show(JSON.parse(event.data).activity, false);
  });
  events.addEventListener('poll', (event) => {
    const message = JSON.parse(event.data);
    const listener = liveListeners.get(message.id);
    if (listener) listener(message);
  });
  events.addEventListener('command', (event) => {
    const command = JSON.parse(event.data);
    if (command.reload) window.location.reload();
    else if (command.redirect) window.location.href = command.redirect;
    else if (command.remount) show(currentActivity, true);
  });

  if (window.__mockWaitingFlashMs && currentActivity) {
    const activity = currentActivity;
    show(null, true);
    setTimeout(() => show(activity, true), window.__mockWaitingFlashMs);
  } else {
    show(currentActivity, true);
  }
})();
