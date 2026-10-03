/*
 * A plain polling page built from ordinary form controls: radio buttons with
 * a separate Submit button, or a text box. Used to test the generic extractor.
 */
(() => {
  const room = document.body.dataset.room;
  const silent = document.body.dataset.silent === 'true';
  const container = document.getElementById('poll');
  const esc = (text) =>
    String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  let current = null;

  function draw(activity) {
    current = activity;
    container.innerHTML = '';
    if (!activity) {
      container.innerHTML = '<p>No question right now.</p>';
      return;
    }
    const api = `/api/polls/${encodeURIComponent(activity.id)}/results`;
    const closed = activity.state !== 'opened';

    const done = (form) => {
      form.querySelectorAll('input, textarea, button').forEach((c) => {
        c.disabled = true;
      });
      if (!silent) {
        const note = document.createElement('p');
        note.setAttribute('role', 'status');
        note.textContent = 'Response recorded. Thank you.';
        form.appendChild(note);
      }
    };
    const failed = (form, message) => {
      let note = form.querySelector('[role="alert"]');
      if (!note) {
        note = document.createElement('p');
        note.setAttribute('role', 'alert');
        form.appendChild(note);
      }
      note.textContent = message;
    };

    if (activity.type === 'multiple_choice_poll') {
      const form = document.createElement('form');
      form.innerHTML = `<fieldset ${closed ? 'disabled' : ''}><legend>${esc(activity.title)}</legend>
        ${activity.options
          .map((o) => `<label class="choice"><input type="radio" name="choice" value="${esc(o.id)}"> ${esc(o.value)}</label>`)
          .join('')}
        <button type="submit">Submit</button></fieldset>${closed ? '<p>This poll is closed.</p>' : ''}`;
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        const picked = form.querySelector('input[name="choice"]:checked');
        if (!picked) return;
        fetch(`${api}?source=generic`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ option_id: picked.value }),
        }).then((r) => (r.ok ? done(form) : failed(form, 'Could not save your response. Try again.')), () => failed(form, 'Network problem. Try again.'));
      });
      container.appendChild(form);
    } else if (activity.type === 'free_text_poll') {
      const form = document.createElement('form');
      form.innerHTML = `<h2>${esc(activity.title)}</h2><textarea name="answer" rows="3" ${closed ? 'disabled' : ''}></textarea>
        <button type="submit" ${closed ? 'disabled' : ''}>Send</button>`;
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        const box = form.querySelector('textarea');
        const value = box.value.trim();
        if (!value) return;
        fetch(`${api}?source=generic`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ value }),
        }).then(
          (r) => {
            if (!r.ok) return failed(form, 'Could not save your response. Try again.');
            box.value = '';
            if (!silent) done(form);
          },
          () => failed(form, 'Network problem. Try again.'),
        );
      });
      container.appendChild(form);
    } else {
      container.innerHTML = `<h2>${esc(activity.title)}</h2><p>This activity type is not shown on this page.</p>`;
    }

    // Restore an earlier response after a reload.
    fetch(api)
      .then((r) => r.json())
      .then((list) => {
        if (current !== activity || !Array.isArray(list) || list.length === 0) return;
        const form = container.querySelector('form');
        if (!form) return;
        const mine = list[list.length - 1];
        const radio = mine.option_id && form.querySelector(`input[value="${CSS.escape(mine.option_id)}"]`);
        if (radio) radio.checked = true;
        form.querySelectorAll('input, textarea, button').forEach((c) => {
          c.disabled = true;
        });
        if (!silent && !form.querySelector('[role="status"]')) {
          const note = document.createElement('p');
          note.setAttribute('role', 'status');
          note.textContent = 'Response recorded. Thank you.';
          form.appendChild(note);
        }
      })
      .catch(() => undefined);
  }

  const events = new EventSource(`/generic/${encodeURIComponent(room)}/events`);
  events.addEventListener('activation', (event) => draw(JSON.parse(event.data).activity));
  events.addEventListener('poll', (event) => {
    const message = JSON.parse(event.data);
    if (!current || current.id !== message.id) return;
    draw({ ...current, ...message });
  });
  events.addEventListener('command', (event) => {
    const command = JSON.parse(event.data);
    if (command.reload) window.location.reload();
    else if (command.redirect) window.location.href = command.redirect;
  });

  draw(window.__mockInitialActivity);
})();
