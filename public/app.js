'use strict';

(() => {
  const STATUSES = [
    { key: 'idea', label: 'Idea', icon: '💡' },
    { key: 'buy', label: 'Buy', icon: '🛒' },
    { key: 'purchased', label: 'Purchased', icon: '💳' },
    { key: 'received', label: 'Received', icon: '📦' },
    { key: 'wrapped', label: 'Wrapped', icon: '🎀' },
  ];
  const STATUS = Object.fromEntries(STATUSES.map((s, i) => [s.key, { ...s, index: i }]));

  const state = {
    user: null,
    currencies: ['USD'],
    filter: 'all',
  };

  const app = document.getElementById('app');
  const modal = document.getElementById('modal');

  // ------------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------------

  // Tiny DOM builder. User data only ever goes in as text, never as HTML.
  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (value == null || value === false) continue;
      if (key === 'class') el.className = value;
      else if (key === 'style' && typeof value === 'object') Object.assign(el.style, value);
      else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
      else if (value === true) el.setAttribute(key, '');
      else el.setAttribute(key, value);
    }
    for (const child of children.flat(Infinity)) {
      if (child == null || child === false) continue;
      el.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return el;
  }

  // replaceChildren() that accepts nested arrays and skips null/false like h() does.
  function fill(el, ...children) {
    el.replaceChildren(...children.flat(Infinity).filter((c) => c != null && c !== false));
  }

  async function api(method, path, body) {
    const res = await fetch(`/api${path}`, {
      method,
      credentials: 'same-origin',
      headers: {
        'X-Requested-With': 'GiftTracker',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let data = {};
    try {
      data = await res.json();
    } catch {
      /* empty body */
    }
    if (res.status === 401 && !path.startsWith('/auth/')) {
      state.user = null;
      render();
    }
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  function money(cents) {
    const currency = (state.user && state.user.currency) || 'USD';
    const whole = cents % 100 === 0;
    try {
      return new Intl.NumberFormat(undefined, {
        style: 'currency',
        currency,
        minimumFractionDigits: whole ? 0 : undefined,
        maximumFractionDigits: whole ? 0 : undefined,
      }).format(cents / 100);
    } catch {
      return `${currency} ${(cents / 100).toFixed(2)}`;
    }
  }

  const centsToInput = (cents) => (cents ? (cents / 100).toFixed(2).replace(/\.00$/, '') : '');

  function initials(name) {
    const parts = name.trim().split(/\s+/).filter(Boolean);
    return ((parts[0] || '?')[0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
  }

  function avatarColor(name) {
    let hash = 0;
    for (const ch of name) hash = (hash * 31 + ch.codePointAt(0)) | 0;
    return `hsl(${Math.abs(hash) % 360} 60% 50%)`;
  }

  const avatar = (name, large) =>
    h('span', { class: `avatar${large ? ' avatar-lg' : ''}`, style: { background: avatarColor(name) }, 'aria-hidden': 'true' }, initials(name));

  function pill(status, text) {
    const s = STATUS[status];
    return h('span', { class: `pill st-${status}` }, h('span', { 'aria-hidden': 'true' }, s.icon), text ?? s.label);
  }

  let toastTimer;
  function toast(message) {
    const el = document.getElementById('toast');
    el.textContent = message;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
  }

  function hostname(url) {
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch {
      return url;
    }
  }

  function budgetBar(person) {
    const budget = person.budget_cents;
    const spent = person.spent_cents;
    const planned = person.planned_cents;
    const scale = Math.max(budget, spent + planned, 1);
    const over = budget > 0 && spent + planned > budget;
    const remaining = budget - spent - planned;
    return h('div', { class: `budget${over ? ' over' : ''}` },
      h('div', {
        class: 'budget-bar',
        role: 'img',
        'aria-label': `${money(spent)} spent and ${money(planned)} planned of ${budget ? money(budget) : 'no'} budget`,
      },
        h('span', { class: 'spent', style: { width: `${(spent / scale) * 100}%` } }),
        h('span', { class: 'planned', style: { width: `${(planned / scale) * 100}%` } }),
      ),
      h('div', { class: 'budget-legend' },
        h('span', null, h('strong', null, money(spent)), ' spent', planned ? [' · ', h('strong', null, money(planned)), ' to buy'] : null),
        budget
          ? h('span', { class: 'remaining' }, remaining >= 0 ? `${money(remaining)} left of ${money(budget)}` : `${money(-remaining)} over ${money(budget)}`)
          : h('span', null, 'No budget set'),
      ),
    );
  }

  // ------------------------------------------------------------------------
  // Modal forms
  // ------------------------------------------------------------------------

  function openModal(title, fields, { submitLabel = 'Save', onSubmit, danger = false, extra } = {}) {
    const error = h('p', { class: 'form-error', role: 'alert' });
    const submit = h('button', { class: danger ? 'btn btn-danger' : 'btn', type: 'submit' }, submitLabel);
    const form = h('form', { method: 'dialog', novalidate: true },
      h('h2', null, title),
      extra,
      fields,
      error,
      h('div', { class: 'modal-actions' },
        h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => modal.close() }, 'Cancel'),
        submit,
      ),
    );
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      error.textContent = '';
      submit.disabled = true;
      try {
        await onSubmit(new FormData(form));
        modal.close();
      } catch (err) {
        error.textContent = err.message;
      } finally {
        submit.disabled = false;
      }
    });
    fill(modal, form);
    modal.showModal();
    const first = form.querySelector('input, textarea, select');
    if (first) first.focus();
  }

  modal.addEventListener('click', (event) => {
    if (event.target === modal) modal.close(); // backdrop click
  });

  const field = (label, input, cls) => h('label', { class: `field ${cls || ''}` }, h('span', null, label), input);

  function personForm(person, onSaved) {
    openModal(person ? 'Edit person' : 'Add a person', [
      field('Name', h('input', { name: 'name', required: true, maxlength: 80, value: person ? person.name : '', autocomplete: 'off' })),
      field(`Budget (${state.user.currency})`, h('input', {
        name: 'budget', inputmode: 'decimal', placeholder: 'e.g. 50', value: person ? centsToInput(person.budget_cents) : '',
      })),
      field('Notes (optional)', h('textarea', { name: 'notes', maxlength: 1000, placeholder: 'Sizes, favourite colours, things they already have…' }, person ? person.notes : '')),
    ], {
      submitLabel: person ? 'Save' : 'Add person',
      onSubmit: async (data) => {
        const body = { name: data.get('name'), budget: data.get('budget'), notes: data.get('notes') };
        const result = person ? await api('PATCH', `/people/${person.id}`, body) : await api('POST', '/people', body);
        onSaved(result.person);
      },
    });
  }

  function giftForm(gift, onSaved) {
    openModal('Edit gift', [
      field('Item name', h('input', { name: 'name', required: true, maxlength: 140, value: gift.name })),
      field('Link', h('input', { name: 'url', type: 'url', placeholder: 'https://…', value: gift.url })),
      field(`Price (${state.user.currency})`, h('input', { name: 'price', inputmode: 'decimal', value: centsToInput(gift.price_cents) })),
      field('Status', h('select', { name: 'status' },
        STATUSES.map((s) => h('option', { value: s.key, selected: s.key === gift.status }, `${s.icon} ${s.label}`)))),
    ], {
      onSubmit: async (data) => {
        const { gift: updated } = await api('PATCH', `/gifts/${gift.id}`, {
          name: data.get('name'), url: data.get('url'), price: data.get('price'), status: data.get('status'),
        });
        onSaved(updated);
      },
    });
  }

  function confirmDialog(title, message, confirmLabel, onConfirm) {
    openModal(title, [], { submitLabel: confirmLabel, danger: true, extra: h('p', null, message), onSubmit: onConfirm });
  }

  // ------------------------------------------------------------------------
  // Views
  // ------------------------------------------------------------------------

  function renderAuth(mode = 'login') {
    const error = h('p', { class: 'form-error', role: 'alert' });
    const isSignup = mode === 'signup';
    const guessCurrency = () => {
      const region = (navigator.language || '').split('-')[1];
      return { GB: 'GBP', CA: 'CAD', AU: 'AUD', NZ: 'NZD', JP: 'JPY', IN: 'INR', IE: 'EUR', DE: 'EUR', FR: 'EUR', ES: 'EUR', IT: 'EUR', NL: 'EUR' }[region] || 'USD';
    };
    const submit = h('button', { class: 'btn', type: 'submit' }, isSignup ? 'Create account' : 'Log in');

    const form = h('form', { novalidate: true },
      isSignup && field('Your name', h('input', { name: 'name', required: true, autocomplete: 'name', maxlength: 80 })),
      field('Email', h('input', { name: 'email', type: 'email', required: true, autocomplete: 'email' })),
      field('Password', h('input', {
        name: 'password', type: 'password', required: true, minlength: isSignup ? 8 : null,
        autocomplete: isSignup ? 'new-password' : 'current-password',
        placeholder: isSignup ? 'At least 8 characters' : null,
      })),
      isSignup && field('Currency', h('select', { name: 'currency' },
        state.currencies.map((c) => h('option', { value: c, selected: c === guessCurrency() }, c)))),
      error,
      submit,
    );
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      error.textContent = '';
      submit.disabled = true;
      const data = Object.fromEntries(new FormData(form));
      try {
        const { user } = await api('POST', isSignup ? '/auth/register' : '/auth/login', data);
        state.user = user;
        if (location.hash !== '#/') location.hash = '#/';
        else render();
      } catch (err) {
        error.textContent = err.message;
        submit.disabled = false;
      }
    });

    const tab = (key, label) => h('button', {
      type: 'button', role: 'tab', 'aria-selected': String(mode === key), onclick: () => renderAuth(key),
    }, label);

    fill(app, h('section', { class: 'auth' },
      h('div', { class: 'auth-hero' },
        h('div', { class: 'brand', style: { marginBottom: '20px' } }, h('span', { class: 'brand-mark' }, '🎁'), 'Giftlist'),
        h('h1', null, 'Every gift idea, budget and bow — in one place.'),
        h('p', null, 'Add the people you buy for, set a budget for each, jot down ideas with links and prices, and track every gift from idea to wrapped.'),
        h('ul', { class: 'auth-steps' }, STATUSES.map((s) => h('li', null, pill(s.key)))),
      ),
      h('div', { class: 'card auth-card' },
        h('div', { class: 'tabs', role: 'tablist' }, tab('login', 'Log in'), tab('signup', 'Sign up')),
        form,
      ),
    ));
    form.querySelector('input').focus();
  }

  async function renderPeople() {
    fill(app, h('div', { class: 'loading-page' }, 'Loading…'));
    const { people } = await api('GET', '/people');

    const totals = people.reduce((t, p) => ({
      budget: t.budget + p.budget_cents,
      spent: t.spent + p.spent_cents,
      // Ideas aren't committed to yet, so only gifts at Buy or later count.
      chosen: t.chosen + p.gift_count - p.n_idea,
      wrapped: t.wrapped + p.n_wrapped,
    }), { budget: 0, spent: 0, chosen: 0, wrapped: 0 });

    const addPerson = () => personForm(null, (person) => { location.hash = `#/people/${person.id}`; });

    const stat = (label, value) => h('div', { class: 'card stat' }, h('div', { class: 'stat-label' }, label), h('div', { class: 'stat-value' }, value));

    const content = people.length
      ? h('div', { class: 'grid' },
        people.map((p) => h('a', { class: 'card person-card', href: `#/people/${p.id}` },
          h('div', { class: 'person-top' },
            avatar(p.name),
            h('div', { style: { minWidth: 0 } },
              h('div', { class: 'person-name' }, p.name),
              h('div', { class: 'person-sub' }, `${p.gift_count} gift${p.gift_count === 1 ? '' : 's'}`),
            ),
          ),
          budgetBar(p),
          p.gift_count
            ? h('div', { class: 'status-counts' }, STATUSES.filter((s) => p[`n_${s.key}`]).map((s) => pill(s.key, `${p[`n_${s.key}`]} ${s.label}`)))
            : h('div', { class: 'person-sub' }, 'No ideas yet'),
        )),
        h('button', { class: 'add-card', type: 'button', onclick: addPerson }, h('span', { class: 'plus' }, '+'), 'Add a person'),
      )
      : h('div', { class: 'card empty' },
        h('div', { class: 'big' }, '🎄'),
        h('h2', null, 'Who are you shopping for?'),
        h('p', null, 'Add your first person and give them a budget to get started.'),
        h('button', { class: 'btn', type: 'button', onclick: addPerson, style: { marginTop: '12px' } }, '+ Add a person'),
      );

    fill(app,
      h('div', { class: 'page-head' },
        h('div', null, h('h1', null, `Hi ${state.user.name.split(' ')[0]} 👋`), h('p', null, 'Your gift list at a glance.')),
        people.length ? h('button', { class: 'btn', type: 'button', onclick: addPerson }, '+ Add person') : null,
      ),
      people.length
        ? h('div', { class: 'stats' },
          stat('People', people.length),
          stat('Total budget', money(totals.budget)),
          stat('Spent', money(totals.spent)),
          stat('Wrapped', `${totals.wrapped} / ${totals.chosen}`))
        : null,
      content,
    );
  }

  async function renderPerson(personId) {
    fill(app, h('div', { class: 'loading-page' }, 'Loading…'));
    let person;
    try {
      ({ person } = await api('GET', `/people/${personId}`));
    } catch (err) {
      fill(app, h('div', { class: 'card empty' },
        h('div', { class: 'big' }, '🤷'), h('h2', null, 'Person not found'), h('p', null, err.message),
        h('a', { class: 'btn', href: '#/' }, 'Back to everyone')));
      return;
    }
    let gifts = person.gifts;

    const recompute = () => {
      person.spent_cents = gifts.filter((g) => STATUS[g.status].index >= 2).reduce((s, g) => s + g.price_cents, 0);
      person.planned_cents = gifts.filter((g) => g.status === 'buy').reduce((s, g) => s + g.price_cents, 0);
    };

    // --- Header
    const header = h('section', { class: 'card person-header' });
    function drawHeader() {
      fill(header,
        h('div', { class: 'person-header-top' },
          h('div', { class: 'person-top' },
            avatar(person.name, true),
            h('div', null, h('h1', null, person.name), h('div', { class: 'person-sub' }, person.budget_cents ? `Budget ${money(person.budget_cents)}` : 'No budget set')),
          ),
          h('div', { class: 'actions' },
            h('button', {
              class: 'btn btn-ghost btn-sm', type: 'button',
              onclick: () => personForm(person, (updated) => { Object.assign(person, updated); gifts = updated.gifts; drawAll(); toast('Saved'); }),
            }, 'Edit'),
            h('button', {
              class: 'btn btn-danger btn-sm', type: 'button',
              onclick: () => confirmDialog(`Remove ${person.name}?`, `This deletes ${person.name} and all ${gifts.length} of their gift ideas. This can't be undone.`, 'Delete', async () => {
                await api('DELETE', `/people/${person.id}`);
                toast(`${person.name} removed`);
                location.hash = '#/';
              }),
            }, 'Delete'),
          ),
        ),
        budgetBar(person),
        person.notes ? h('p', { class: 'notes' }, person.notes) : null,
      );
    }

    // --- Add gift form
    const addError = h('p', { class: 'form-error', role: 'alert' });
    const addButton = h('button', { class: 'btn', type: 'submit' }, 'Add idea');
    const addForm = h('form', { novalidate: true },
      field('Item name', h('input', { name: 'name', required: true, maxlength: 140, placeholder: 'e.g. Wireless headphones', autocomplete: 'off' }), 'field-name'),
      field('Link (optional)', h('input', { name: 'url', type: 'url', placeholder: 'https://shop.example/item' }), 'field-url'),
      field(`Price (${state.user.currency})`, h('input', { name: 'price', inputmode: 'decimal', placeholder: '0.00' })),
      addButton,
      addError,
    );
    addForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      addError.textContent = '';
      const data = Object.fromEntries(new FormData(addForm));
      if (!data.name.trim()) {
        addError.textContent = 'Give the item a name.';
        return;
      }
      addButton.disabled = true;
      addButton.textContent = data.url ? 'Finding picture…' : 'Adding…';
      try {
        const { gift } = await api('POST', `/people/${person.id}/gifts`, data);
        gifts = [gift, ...gifts];
        addForm.reset();
        if (state.filter !== 'all' && state.filter !== 'idea') state.filter = 'all';
        drawAll();
        addForm.querySelector('input').focus();
      } catch (err) {
        addError.textContent = err.message;
      } finally {
        addButton.disabled = false;
        addButton.textContent = 'Add idea';
      }
    });

    const filters = h('div', { class: 'filters', role: 'toolbar', 'aria-label': 'Filter by status' });
    const grid = h('div', { class: 'gift-grid' });

    function drawFilters() {
      const btn = (key, label, count) => h('button', {
        type: 'button', 'aria-pressed': String(state.filter === key),
        onclick: () => { state.filter = key; drawFilters(); drawGifts(); },
      }, label, h('span', { class: 'count' }, count));
      fill(filters,
        btn('all', 'All', gifts.length),
        STATUSES.map((s) => btn(s.key, `${s.icon} ${s.label}`, gifts.filter((g) => g.status === s.key).length)),
      );
    }

    function replaceGift(updated) {
      gifts = gifts.map((g) => (g.id === updated.id ? updated : g));
      recompute();
      drawAll();
    }

    async function setStatus(gift, status) {
      if (status === gift.status) return;
      try {
        const { gift: updated } = await api('PATCH', `/gifts/${gift.id}`, { status });
        replaceGift(updated);
        toast(`${updated.name} → ${STATUS[status].label}`);
      } catch (err) {
        toast(err.message);
      }
    }

    function giftCard(gift) {
      const s = STATUS[gift.status];
      const next = STATUSES[s.index + 1];
      const imageBox = h('div', { class: `gift-image${gift.image_source === 'product' ? ' product' : ''}` },
        h('img', { src: gift.image_url, alt: '', loading: 'lazy' }),
        pill(gift.status),
      );

      const menuList = h('div', { class: 'menu-list', role: 'menu', hidden: true });
      const menuButton = h('button', {
        class: 'btn btn-ghost btn-icon', type: 'button', 'aria-label': `More actions for ${gift.name}`, 'aria-haspopup': 'menu',
        onclick: (event) => {
          event.stopPropagation();
          const open = menuList.hidden;
          document.querySelectorAll('.menu-list').forEach((m) => { m.hidden = true; });
          menuList.hidden = !open;
        },
      }, '⋯');
      const menuItem = (label, onclick, cls) => h('button', { type: 'button', role: 'menuitem', class: cls, onclick: () => { menuList.hidden = true; onclick(); } }, label);

      async function regenerate(source) {
        imageBox.classList.add('loading');
        try {
          const { gift: updated } = await api('POST', `/gifts/${gift.id}/image`, { source });
          replaceGift(updated);
          toast(updated.image_source === 'product' ? 'Found a product photo' : 'New picture generated');
        } catch (err) {
          imageBox.classList.remove('loading');
          toast(err.message);
        }
      }

      menuList.append(
        menuItem('✏️ Edit details', () => giftForm(gift, (updated) => { replaceGift(updated); toast('Saved'); })),
        gift.url ? menuItem('🔍 Use product photo', () => regenerate('auto')) : null,
        menuItem('🎨 Generate artwork', () => regenerate('generated')),
        s.index > 0 ? menuItem(`↩️ Back to ${STATUSES[s.index - 1].label}`, () => setStatus(gift, STATUSES[s.index - 1].key)) : null,
        menuItem('🗑️ Delete', () => confirmDialog('Delete this gift?', `“${gift.name}” will be removed.`, 'Delete', async () => {
          await api('DELETE', `/gifts/${gift.id}`);
          gifts = gifts.filter((g) => g.id !== gift.id);
          recompute();
          drawAll();
        }), 'danger'),
      );

      return h('article', { class: 'card gift-card' },
        imageBox,
        h('div', { class: 'gift-body' },
          h('div', { class: 'gift-title-row' },
            h('div', { class: 'gift-name' }, gift.name),
            h('div', { class: 'gift-price' }, gift.price_cents ? money(gift.price_cents) : '—'),
          ),
          gift.url ? h('a', { class: 'gift-link', href: gift.url, target: '_blank', rel: 'noopener noreferrer' }, `🔗 ${hostname(gift.url)}`) : null,
          h('ol', { class: 'stepper', 'aria-label': 'Status' },
            STATUSES.map((st, i) => h('li', { class: `st-${st.key} ${i <= s.index ? 'done' : ''} ${st.key === gift.status ? 'current' : ''}` },
              h('button', {
                type: 'button', title: `Mark as ${st.label}`, 'aria-current': st.key === gift.status ? 'step' : null,
                onclick: () => setStatus(gift, st.key),
              }, h('span', { class: 'bar' }), st.label))),
          ),
        ),
        h('div', { class: 'gift-foot' },
          next
            ? h('button', { class: 'btn btn-sm', type: 'button', onclick: () => setStatus(gift, next.key) }, `${next.icon} Move to ${next.label}`)
            : h('span', { class: 'pill st-wrapped', style: { flex: 1, justifyContent: 'center', padding: '6px' } }, '🎉 Ready to give!'),
          h('div', { class: 'menu' }, menuButton, menuList),
        ),
      );
    }

    function drawGifts() {
      const shown = state.filter === 'all' ? gifts : gifts.filter((g) => g.status === state.filter);
      if (!gifts.length) {
        fill(grid, h('div', { class: 'card empty', style: { gridColumn: '1 / -1' } },
          h('div', { class: 'big' }, '💡'), h('h2', null, 'No gift ideas yet'), h('p', null, `Add your first idea for ${person.name} above.`)));
      } else if (!shown.length) {
        fill(grid, h('div', { class: 'empty', style: { gridColumn: '1 / -1' } }, `Nothing at “${STATUS[state.filter].label}” right now.`));
      } else {
        fill(grid, ...shown.map(giftCard));
      }
    }

    function drawAll() {
      drawHeader();
      drawFilters();
      drawGifts();
    }

    state.filter = 'all';
    recompute();
    drawAll();
    fill(app,
      h('a', { class: 'back', href: '#/' }, '← Everyone'),
      header,
      h('section', { class: 'card add-gift' }, h('h2', null, 'Add a gift idea'), addForm),
      filters,
      grid,
    );
  }

  // ------------------------------------------------------------------------
  // Shell & routing
  // ------------------------------------------------------------------------

  function drawTopbar() {
    const topbar = document.getElementById('topbar');
    topbar.hidden = !state.user;
    if (!state.user) return;
    document.getElementById('account-name').textContent = state.user.email;
    const select = document.getElementById('currency-select');
    fill(select, ...state.currencies.map((c) => h('option', { value: c, selected: c === state.user.currency }, c)));
  }

  document.getElementById('currency-select').addEventListener('change', async (event) => {
    try {
      const { user } = await api('PATCH', '/auth/me', { currency: event.target.value });
      state.user = user;
      render();
    } catch (err) {
      toast(err.message);
    }
  });

  document.getElementById('logout-btn').addEventListener('click', async () => {
    await api('POST', '/auth/logout').catch(() => {});
    state.user = null;
    location.hash = '#/';
    render();
  });

  document.addEventListener('click', () => {
    document.querySelectorAll('.menu-list').forEach((m) => { m.hidden = true; });
  });

  async function render() {
    drawTopbar();
    if (!state.user) return renderAuth();
    const match = location.hash.match(/^#\/people\/(\d+)/);
    try {
      if (match) await renderPerson(match[1]);
      else await renderPeople();
    } catch (err) {
      if (state.user) {
        fill(app, h('div', { class: 'card empty' }, h('h2', null, 'Something went wrong'), h('p', null, err.message),
          h('button', { class: 'btn', type: 'button', onclick: render }, 'Try again')));
      }
    }
    window.scrollTo(0, 0);
  }

  window.addEventListener('hashchange', render);

  (async function boot() {
    try {
      const me = await api('GET', '/auth/me');
      state.user = me.user;
      state.currencies = me.currencies;
    } catch {
      state.user = null;
    }
    render();
  })();
})();
