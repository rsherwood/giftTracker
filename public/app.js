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
    plans: { enabled: false, price_label: '£5/year', free_people_limit: 2 },
    billing: null,
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
    if (!res.ok) {
      const err = new Error(data.error || `Request failed (${res.status})`);
      err.code = data.code;
      throw err;
    }
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
        let result;
        try {
          result = person ? await api('PATCH', `/people/${person.id}`, body) : await api('POST', '/people', body);
        } catch (err) {
          if (err.code === 'upgrade_required') {
            modal.close();
            showUpgrade();
            return;
          }
          throw err;
        }
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

  // ------------------------------------------------------------------------
  // Plans & billing
  // ------------------------------------------------------------------------

  // Matches the server: "Christmas 2026" until mid-2027.
  function defaultOccasion(now = new Date()) {
    return `Christmas ${now.getMonth() < 6 ? now.getFullYear() - 1 : now.getFullYear()}`;
  }

  const hasPremium = () => Boolean(state.billing && state.billing.premium);

  async function refreshBilling() {
    try {
      state.billing = (await api('GET', '/billing')).billing;
    } catch {
      state.billing = null;
    }
    drawTopbar();
    return state.billing;
  }

  const atFreeLimit = () => {
    const b = state.billing;
    return Boolean(b && b.enabled && !b.premium && b.people_count >= b.free_people_limit);
  };

  async function startCheckout() {
    const { url } = await api('POST', '/billing/checkout');
    location.href = url;
    // Keep the button disabled while the browser leaves for Stripe.
    await new Promise(() => {});
  }

  async function openPortal() {
    try {
      const { url } = await api('POST', '/billing/portal');
      location.href = url;
    } catch (err) {
      toast(err.message);
    }
  }

  function showUpgrade() {
    const b = state.billing || state.plans;
    openModal('Upgrade to Premium', [], {
      submitLabel: `⭐ Upgrade – ${b.price_label}`,
      extra: h('div', { class: 'upgrade-pitch' },
        h('p', null, `The free plan covers ${b.free_people_limit} people. Premium lets you plan gifts for everyone on your list.`),
        h('ul', { class: 'perks' },
          h('li', null, '🎁 Unlimited people and gift ideas'),
          h('li', null, '🗄️ Past gifts: remember what you gave everyone in previous years'),
          h('li', null, '💷 One simple price: ', h('strong', null, b.price_label)),
          h('li', null, '🔒 Secure payment by Stripe. Cancel renewal any time.'),
        ),
        h('p', { class: 'fine-print' }, 'Renews every year until you cancel. By upgrading you agree to our ',
          h('a', { href: '/terms', target: '_blank' }, 'Terms'), '.'),
      ),
      onSubmit: startCheckout,
    });
  }

  function planCard() {
    const b = state.billing;
    if (!b) return h('div', { class: 'card plan-card' }, h('p', null, 'Couldn’t load your plan. Please refresh.'));
    const date = (ms) => new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });

    if (!b.enabled) {
      return h('div', { class: 'card plan-card' }, h('h2', null, 'Your plan'), h('p', null, 'Everything is unlocked on this site.'));
    }
    if (b.premium) {
      const sub = b.subscription;
      let detail = 'Unlimited people and gift ideas.';
      if (b.comped) detail = 'Complimentary Premium – no payment needed.';
      else if (sub && sub.status === 'past_due') detail = 'Your last payment didn’t go through. Please update your card to keep Premium.';
      else if (sub && sub.period_end) detail = sub.cancel_at_period_end ? `Ends on ${date(sub.period_end)}. It won’t renew.` : `Renews on ${date(sub.period_end)}.`;
      return h('div', { class: 'card plan-card premium' },
        h('div', { class: 'plan-title' }, h('h2', null, 'Premium'), h('span', { class: 'plan-chip premium' }, '⭐ Premium')),
        h('p', null, detail),
        sub && !b.comped ? h('button', { class: 'btn btn-ghost', type: 'button', onclick: openPortal }, 'Manage subscription & invoices') : null,
      );
    }
    const used = Math.min(b.people_count, b.free_people_limit);
    return h('div', { class: 'card plan-card' },
      h('div', { class: 'plan-title' }, h('h2', null, 'Free plan'), h('span', { class: 'plan-chip' }, `${used} of ${b.free_people_limit} people used`)),
      h('div', { class: 'meter', role: 'img', 'aria-label': `${used} of ${b.free_people_limit} free people used` },
        h('span', { style: { width: `${(used / b.free_people_limit) * 100}%` } })),
      b.people_count > b.free_people_limit
        ? h('p', null, `You have ${b.people_count} people from an earlier Premium subscription. They’re all still here, but only the first ${b.free_people_limit} you added can be changed. Upgrade again to edit everyone.`)
        : null,
      h('p', null, `Upgrade to Premium for unlimited people – just ${b.price_label}.`),
      h('div', { class: 'actions' },
        h('button', { class: 'btn', type: 'button', onclick: showUpgrade }, '⭐ Upgrade to Premium'),
        b.subscription ? h('button', { class: 'btn btn-ghost', type: 'button', onclick: openPortal }, 'Past invoices') : null,
      ),
    );
  }

  async function renderAccount(params) {
    fill(app, h('div', { class: 'loading-page' }, 'Loading…'));
    await refreshBilling();
    const returning = params.get('checkout') === 'success';

    const nameInput = h('input', { name: 'name', required: true, maxlength: 80, value: state.user.name, autocomplete: 'name' });
    const nameError = h('p', { class: 'form-error', role: 'alert' });
    const currencySelect = h('select', { name: 'currency' },
      state.currencies.map((c) => h('option', { value: c, selected: c === state.user.currency }, c)));
    const nameForm = h('form', { class: 'inline-form', novalidate: true },
      field('Name', nameInput),
      field('Currency symbol', currencySelect),
      h('p', { class: 'field-note' },
        'This only changes the symbol shown next to your amounts. ',
        h('strong', null, 'It doesn’t convert them'),
        ' – for example, £50 would simply show as $50. Your Premium price isn’t affected.'),
      h('button', { class: 'btn btn-ghost', type: 'submit' }, 'Save'),
      nameError,
    );
    nameForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      nameError.textContent = '';
      try {
        state.user = (await api('PATCH', '/auth/me', { name: nameInput.value, currency: currencySelect.value })).user;
        toast('Saved');
      } catch (err) {
        nameError.textContent = err.message;
      }
    });

    const planSlot = h('div', null, planCard());
    const deleteCard = h('div', { class: 'card plan-card danger-zone' },
      h('h2', null, 'Delete account'),
      h('p', null, 'Permanently delete your account, everyone on your list and all their gift ideas. This can’t be undone.'),
      h('button', { class: 'btn btn-danger', type: 'button', onclick: confirmDeleteAccount }, 'Delete my account'));
    fill(app,
      h('a', { class: 'back', href: '#/' }, '← Everyone'),
      h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Your account'), h('p', null, state.user.email))),
      h('div', { class: 'account-grid' },
        planSlot,
        h('div', { class: 'card plan-card' }, h('h2', null, 'Profile'), nameForm),
        deleteCard,
      ),
    );

    // Stripe confirms payment with a webhook, which can take a few seconds.
    if (returning && !state.billing?.premium) {
      fill(planSlot, h('div', { class: 'card plan-card' }, h('h2', null, 'Confirming your payment…'), h('p', null, 'This usually takes a few seconds.')));
      for (let i = 0; i < 10 && !state.billing?.premium; i++) {
        await new Promise((r) => setTimeout(r, 1500));
        await refreshBilling();
      }
      fill(planSlot, planCard());
      if (!state.billing?.premium) toast('Payment received – Premium will appear shortly. Try refreshing in a minute.');
    }
    if (returning && state.billing?.premium) {
      toast('🎉 Welcome to Premium!');
      history.replaceState(null, '', '#/account');
    }
  }

  function confirmDeleteAccount() {
    openModal('Delete your account?', [
      field('Enter your password to confirm', h('input', { name: 'password', type: 'password', required: true, autocomplete: 'current-password' })),
    ], {
      danger: true,
      submitLabel: 'Delete everything',
      extra: h('p', null, 'Your account, everyone on your list and all their gift ideas will be deleted straight away.'),
      onSubmit: async (data) => {
        await api('DELETE', '/auth/me', { password: data.get('password') });
        state.user = null;
        state.billing = null;
        location.hash = '#/';
        render();
        toast('Your account has been deleted');
      },
    });
  }

  function openFeatureRequest() {
    const loggedIn = Boolean(state.user);
    const message = h('textarea', {
      name: 'message', required: true, maxlength: 3000, rows: 5,
      placeholder: 'What would make Giftlist more useful for you?',
    });
    openModal('💡 Request a feature', [
      field('Your idea', message),
      loggedIn ? null : field('Your name (optional)', h('input', { name: 'name', maxlength: 80, autocomplete: 'name' })),
      loggedIn ? null : field('Your email (optional, so we can reply)', h('input', { name: 'email', type: 'email', autocomplete: 'email' })),
      // Hidden from people; catches spam bots that fill in every field.
      h('input', { name: 'website', class: 'hp-field', tabindex: '-1', autocomplete: 'off', 'aria-hidden': 'true' }),
    ], {
      submitLabel: 'Send',
      extra: h('p', null, loggedIn
        ? 'We read every suggestion. We’ll reply to your account email if we have questions.'
        : 'We read every suggestion.'),
      onSubmit: async (data) => {
        await api('POST', '/feedback', Object.fromEntries(data));
        toast('Thanks! Your idea has been sent 💡');
      },
    });
  }

  // ------------------------------------------------------------------------
  // Admin (site owner only)
  // ------------------------------------------------------------------------

  async function renderAdmin() {
    fill(app, h('div', { class: 'loading-page' }, 'Loading…'));
    let data;
    try {
      data = await api('GET', '/admin/stats');
    } catch {
      location.hash = '#/';
      return;
    }
    const t = data.totals;
    const dbDate = (s) => new Date(`${s.replace(' ', 'T')}Z`);
    const day = (d) => (d ? new Date(d).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
    const ago = (ms) => {
      if (!ms) return '—';
      const days = Math.floor((Date.now() - ms) / 86400000);
      return days <= 0 ? 'Today' : days === 1 ? 'Yesterday' : days < 30 ? `${days} days ago` : day(ms);
    };
    const stat = (label, value, note) => h('div', { class: 'card stat' },
      h('div', { class: 'stat-label' }, label), h('div', { class: 'stat-value' }, value), note ? h('div', { class: 'stat-note' }, note) : null);

    const paying = t.premium;
    const priceMatch = String((state.billing || state.plans).price_label).match(/^(\D*)(\d+(?:\.\d+)?)/);
    const yearly = priceMatch ? `≈ ${priceMatch[1]}${(paying * Number(priceMatch[2])).toLocaleString()} a year` : null;

    const planChip = (u) => {
      if (u.plan === 'comped') return h('span', { class: 'plan-chip premium' }, '⭐ Comped');
      if (u.plan !== 'premium') return h('span', { class: 'plan-chip' }, 'Free');
      if (u.subscription_status === 'past_due') return h('span', { class: 'plan-chip warn' }, '⚠️ Payment failed');
      if (u.cancelling) return h('span', { class: 'plan-chip premium', title: `Ends ${day(u.renews_or_ends)}` }, '⭐ Cancelling');
      return h('span', { class: 'plan-chip premium', title: `Renews ${day(u.renews_or_ends)}` }, '⭐ Premium');
    };

    const tbody = h('tbody');
    const search = h('input', { type: 'search', placeholder: 'Search name or email…', 'aria-label': 'Search users' });
    const drawUsers = () => {
      const term = search.value.trim().toLowerCase();
      const list = data.users.filter((u) => !term || u.name.toLowerCase().includes(term) || u.email.toLowerCase().includes(term));
      fill(tbody, list.length
        ? list.map((u) => h('tr', null,
          h('td', null, h('div', { class: 'cell-strong' }, u.name), h('div', { class: 'person-sub' }, u.email)),
          h('td', null, planChip(u)),
          h('td', { class: 'num' }, u.people),
          h('td', { class: 'num' }, u.gifts),
          h('td', null, day(dbDate(u.joined))),
          h('td', null, ago(u.last_login))))
        : h('tr', null, h('td', { colspan: 6, class: 'empty-cell' }, 'No matching users.')));
    };
    search.addEventListener('input', drawUsers);
    drawUsers();

    const maxWeek = Math.max(1, ...data.signups_by_week.map((w) => w.n));

    fill(app,
      h('div', { class: 'page-head' },
        h('div', null, h('h1', null, '📊 Admin'), h('p', null, `Updated ${new Date(data.generated_at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })} · only visible to you`)),
        h('button', { class: 'btn btn-ghost', type: 'button', onclick: renderAdmin }, '↻ Refresh')),
      h('div', { class: 'stats' },
        stat('Users', t.users, `+${t.users_7d} this week · +${t.users_30d} in 30 days`),
        stat('Premium', paying, yearly),
        stat('Logged in', t.active_7d, `in the last 7 days · ${t.active_30d} in 30 days`),
        stat('Gifts', t.gifts, `${t.people} people · ${t.archived_gifts} past gifts`)),
      h('div', { class: 'admin-grid' },
        h('section', { class: 'card admin-card' },
          h('h2', null, 'Subscriptions'),
          h('ul', { class: 'admin-list' },
            h('li', null, h('span', null, '⭐ Paying'), h('strong', null, paying)),
            h('li', null, h('span', null, '↩️ Cancelling at period end'), h('strong', null, t.cancelling)),
            h('li', null, h('span', null, '⚠️ Payment failed (Stripe retrying)'), h('strong', null, t.past_due)),
            h('li', null, h('span', null, '🎟️ Comped (PREMIUM_EMAILS)'), h('strong', null, t.comped)),
            h('li', null, h('span', null, 'Free'), h('strong', null, Math.max(t.users - paying - t.comped, 0))))),
        h('section', { class: 'card admin-card' },
          h('h2', null, 'Gifts by status'),
          h('ul', { class: 'admin-list' }, STATUSES.map((s) => h('li', null, pill(s.key), h('strong', null, data.gifts_by_status[s.key] || 0))))),
        h('section', { class: 'card admin-card' },
          h('h2', null, 'Sign-ups by week'),
          data.signups_by_week.length
            ? h('ul', { class: 'admin-list weeks' }, data.signups_by_week.map((w) => h('li', null,
              h('span', null, `w/c ${day(dbDate(`${w.week_start} 00:00:00`))}`),
              h('span', { class: 'week-bar', 'aria-hidden': 'true' }, h('span', { style: { width: `${(w.n / maxWeek) * 100}%` } })),
              h('strong', null, w.n))))
            : h('p', { class: 'person-sub' }, 'No sign-ups in the last 12 weeks.'))),
      h('section', { class: 'card admin-card' },
        h('div', { class: 'admin-users-head' }, h('h2', null, `Users${data.users.length < t.users ? ` (newest ${data.users.length})` : ''}`), search),
        h('div', { class: 'table-wrap' },
          h('table', { class: 'admin-table' },
            h('thead', null, h('tr', null,
              h('th', null, 'User'), h('th', null, 'Plan'), h('th', { class: 'num' }, 'People'), h('th', { class: 'num' }, 'Gifts'),
              h('th', null, 'Joined'), h('th', null, 'Last login'))),
            tbody))),
    );
  }

  function confirmDialog(title, message, confirmLabel, onConfirm) {
    openModal(title, [], { submitLabel: confirmLabel, danger: true, extra: h('p', null, message), onSubmit: onConfirm });
  }

  // ------------------------------------------------------------------------
  // Views
  // ------------------------------------------------------------------------

  function renderAuth(mode = 'login') {
    if (mode === 'forgot') return renderForgot();
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
      isSignup && field('Currency symbol (you can change it later in Your account)', h('select', { name: 'currency' },
        state.currencies.map((c) => h('option', { value: c, selected: c === guessCurrency() }, c)))),
      error,
      submit,
      isSignup && h('p', { class: 'fine-print' }, 'By creating an account you confirm you’re 18 or over and agree to our ',
        h('a', { href: '/terms', target: '_blank' }, 'Terms'), ' and ', h('a', { href: '/privacy', target: '_blank' }, 'Privacy Policy'), '.'),
      !isSignup && h('button', { class: 'link-button', type: 'button', onclick: () => renderAuth('forgot') }, 'Forgot your password?'),
    );
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      error.textContent = '';
      submit.disabled = true;
      const data = Object.fromEntries(new FormData(form));
      try {
        const { user } = await api('POST', isSignup ? '/auth/register' : '/auth/login', data);
        state.user = user;
        await refreshBilling();
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

    authLayout(
      h('div', { class: 'tabs', role: 'tablist' }, tab('login', 'Log in'), tab('signup', 'Sign up')),
      form,
    );
    form.querySelector('input').focus();
  }

  function authLayout(...cardContent) {
    const p = state.plans;
    fill(app, h('section', { class: 'auth' },
      h('div', { class: 'auth-hero' },
        h('div', { class: 'brand', style: { marginBottom: '20px' } }, h('span', { class: 'brand-mark' }, '🎁'), 'Giftlist'),
        h('h1', null, 'Every gift idea, budget and bow — in one place.'),
        h('p', null, 'Add the people you buy for, set a budget for each, jot down ideas with links and prices, and track every gift from idea to wrapped.'),
        h('ul', { class: 'auth-steps' }, STATUSES.map((s) => h('li', null, pill(s.key)))),
        p.enabled
          ? h('p', { class: 'pricing-note' },
            h('strong', null, 'Free'), ` for up to ${p.free_people_limit} people · `,
            h('strong', null, `Premium ${p.price_label}`), ' for everyone on your list')
          : null,
      ),
      h('div', { class: 'card auth-card' }, cardContent),
    ));
  }

  function renderForgot() {
    const error = h('p', { class: 'form-error', role: 'alert' });
    const submit = h('button', { class: 'btn', type: 'submit' }, 'Email me a reset link');
    const form = h('form', { novalidate: true },
      h('div', null, h('h2', null, 'Reset your password'), h('p', { class: 'muted' }, 'Enter your email and we’ll send you a link to choose a new password.')),
      field('Email', h('input', { name: 'email', type: 'email', required: true, autocomplete: 'email' })),
      error,
      submit,
      h('button', { class: 'link-button', type: 'button', onclick: () => renderAuth('login') }, '← Back to log in'),
    );
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      error.textContent = '';
      submit.disabled = true;
      try {
        await api('POST', '/auth/forgot', { email: form.email.value });
        fill(form,
          h('div', null, h('h2', null, 'Check your email'),
            h('p', { class: 'muted' }, `If there’s an account for ${form.email.value}, we’ve sent a reset link. It works for one hour.`)),
          h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => renderAuth('login') }, 'Back to log in'),
        );
      } catch (err) {
        error.textContent = err.message;
        submit.disabled = false;
      }
    });
    authLayout(form);
    form.querySelector('input').focus();
  }

  function renderReset(token) {
    const error = h('p', { class: 'form-error', role: 'alert' });
    const submit = h('button', { class: 'btn', type: 'submit' }, 'Save new password');
    const form = h('form', { novalidate: true },
      h('div', null, h('h2', null, 'Choose a new password')),
      field('New password', h('input', { name: 'password', type: 'password', required: true, minlength: 8, autocomplete: 'new-password', placeholder: 'At least 8 characters' })),
      field('Confirm new password', h('input', { name: 'confirm', type: 'password', required: true, autocomplete: 'new-password' })),
      error,
      submit,
    );
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      error.textContent = '';
      if (form.password.value !== form.confirm.value) {
        error.textContent = 'The passwords don’t match.';
        return;
      }
      submit.disabled = true;
      try {
        const { user } = await api('POST', '/auth/reset', { token, password: form.password.value });
        state.user = user;
        toast('Password updated – you’re logged in');
        await refreshBilling();
        location.hash = '#/';
      } catch (err) {
        error.textContent = err.message;
        submit.disabled = false;
      }
    });
    drawTopbar();
    authLayout(form);
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
      // Each count includes gifts that have gone further, e.g. wrapped gifts were also purchased.
      purchased: t.purchased + p.n_purchased + p.n_received + p.n_wrapped,
      received: t.received + p.n_received + p.n_wrapped,
      wrapped: t.wrapped + p.n_wrapped,
    }), { budget: 0, spent: 0, chosen: 0, purchased: 0, received: 0, wrapped: 0 });

    await refreshBilling();
    const addPerson = () => (atFreeLimit()
      ? showUpgrade()
      : personForm(null, (person) => { location.hash = `#/people/${person.id}`; }));
    const b = state.billing;
    const freeLeft = b && b.enabled && !b.premium ? Math.max(b.free_people_limit - b.people_count, 0) : null;

    const stat = (label, value) => h('div', { class: 'card stat' }, h('div', { class: 'stat-label' }, label), h('div', { class: 'stat-value' }, value));

    const content = people.length
      ? h('div', { class: 'grid' },
        people.map((p) => h('a', { class: `card person-card${p.locked ? ' locked' : ''}`, href: `#/people/${p.id}` },
          h('div', { class: 'person-top' },
            avatar(p.name),
            h('div', { style: { minWidth: 0 } },
              h('div', { class: 'person-name' }, p.name),
              h('div', { class: 'person-sub' }, `${p.gift_count} gift${p.gift_count === 1 ? '' : 's'}`,
                p.locked ? h('span', { class: 'plan-chip locked-chip', title: 'Upgrade to Premium to edit' }, '🔒 Read-only') : null),
            ),
          ),
          budgetBar(p),
          p.gift_count
            ? h('div', { class: 'status-counts' }, STATUSES.filter((s) => p[`n_${s.key}`]).map((s) => pill(s.key, `${p[`n_${s.key}`]} ${s.label}`)))
            : h('div', { class: 'person-sub' }, 'No ideas yet'),
        )),
        h('button', { class: 'add-card', type: 'button', onclick: addPerson },
          h('span', { class: 'plus' }, freeLeft === 0 ? '⭐' : '+'),
          freeLeft === 0 ? 'Upgrade to add more people' : 'Add a person',
          freeLeft ? h('span', { class: 'add-card-note' }, `${freeLeft} of ${b.free_people_limit} free places left`) : null,
          freeLeft === 0 ? h('span', { class: 'add-card-note' }, `Premium is ${b.price_label}`) : null),
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
        ? h('div', { class: 'stats stats-6' },
          stat('People', people.length),
          stat('Total budget', money(totals.budget)),
          stat('Spent', money(totals.spent)),
          stat('Purchased', `${totals.purchased} / ${totals.chosen}`),
          stat('Received', `${totals.received} / ${totals.chosen}`),
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
            !person.locked && gifts.some((g) => STATUS[g.status].index >= 2)
              ? h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: archiveBought, title: 'Move bought gifts to Past gifts' },
                '🗄️ Archive bought', hasPremium() ? null : ' ⭐')
              : null,
            person.locked ? null : h('button', {
              class: 'btn btn-ghost btn-sm', type: 'button',
              onclick: () => personForm(person, (updated) => { Object.assign(person, updated); gifts = updated.gifts; archived = updated.archived || []; drawAll(); toast('Saved'); }),
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

      fill(menuList,
        menuItem('✏️ Edit details', () => giftForm(gift, (updated) => { replaceGift(updated); toast('Saved'); })),
        gift.url ? menuItem('🔍 Use product photo', () => regenerate('auto')) : null,
        menuItem('🎨 Generate artwork', () => regenerate('generated')),
        menuItem(hasPremium() ? '🗄️ Move to Past gifts' : '🗄️ Move to Past gifts ⭐', () => archiveGift(gift)),
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
                type: 'button', title: person.locked ? st.label : `Mark as ${st.label}`, 'aria-current': st.key === gift.status ? 'step' : null,
                disabled: person.locked,
                onclick: () => setStatus(gift, st.key),
              }, h('span', { class: 'bar' }), st.label))),
          ),
        ),
        person.locked ? null : h('div', { class: 'gift-foot' },
          next
            ? h('button', { class: 'btn btn-sm', type: 'button', onclick: () => setStatus(gift, next.key) }, `${next.icon} Move to ${next.label}`)
            : h('span', { class: 'pill st-wrapped', style: { flex: 1, justifyContent: 'center', padding: '6px' } }, '🎉 Ready to give!'),
          h('div', { class: 'menu' }, menuButton, menuList),
        ),
      );
    }

    // --- Past gifts (Premium)
    let archived = person.archived || [];
    const past = h('section', { class: 'past-gifts' });

    function archiveDialog({ title, message, submitLabel, request }) {
      if (!hasPremium()) {
        showUpgrade();
        return;
      }
      openModal(title, [
        field('Occasion', h('input', { name: 'label', maxlength: 60, value: defaultOccasion(), autocomplete: 'off' })),
      ], {
        submitLabel,
        extra: h('p', null, message),
        onSubmit: async (data) => {
          const result = await request(data.get('label'));
          const fresh = result.person || (await api('GET', `/people/${person.id}`)).person;
          Object.assign(person, fresh);
          gifts = fresh.gifts;
          archived = fresh.archived || [];
          recompute();
          drawAll();
          toast(result.archived === undefined ? 'Moved to Past gifts' : `${result.archived} gift${result.archived === 1 ? '' : 's'} moved to Past gifts`);
        },
      });
    }

    function archiveGift(gift) {
      archiveDialog({
        title: 'Move to Past gifts',
        message: `“${gift.name}” will be kept under Past gifts so you can look back on it, and won’t count towards this budget.`,
        submitLabel: '🗄️ Move to Past gifts',
        request: (label) => api('POST', `/gifts/${gift.id}/archive`, { label }),
      });
    }

    function archiveBought() {
      const bought = gifts.filter((g) => STATUS[g.status].index >= 2).length;
      archiveDialog({
        title: 'Archive bought gifts',
        message: `Moves ${bought} gift${bought === 1 ? '' : 's'} at Purchased, Received or Wrapped into Past gifts and resets this budget. Ideas and gifts still to buy stay where they are.`,
        submitLabel: `🗄️ Archive ${bought} gift${bought === 1 ? '' : 's'}`,
        request: (label) => api('POST', `/people/${person.id}/archive-bought`, { label }),
      });
    }

    async function restoreGift(gift) {
      try {
        const { gift: restored } = await api('POST', `/gifts/${gift.id}/restore`);
        archived = archived.filter((g) => g.id !== gift.id);
        person.archived_count -= 1;
        gifts = [restored, ...gifts];
        recompute();
        drawAll();
        toast(`${restored.name} is back on the list`);
      } catch (err) {
        if (err.code === 'upgrade_required') showUpgrade();
        else toast(err.message);
      }
    }

    function drawPast() {
      if (!hasPremium()) {
        fill(past, person.archived_count
          ? h('div', { class: 'card past-locked' },
            h('div', null,
              h('h2', null, `🗄️ ${person.archived_count} past gift${person.archived_count === 1 ? '' : 's'}`),
              h('p', null, `Past gifts are a Premium feature. They’re safely kept – upgrade to see what you’ve given ${person.name} before.`)),
            h('button', { class: 'btn btn-upgrade', type: 'button', onclick: showUpgrade }, '⭐ Upgrade'))
          : null);
        return;
      }
      if (!archived.length) {
        fill(past, h('div', { class: 'past-hint' },
          '🗄️ When an occasion’s over, use ', h('strong', null, 'Archive bought'),
          ` to keep a record of what you gave ${person.name} under Past gifts.`));
        return;
      }
      // Group by occasion, newest first (the list already arrives newest first).
      const groups = new Map();
      for (const g of archived) {
        const key = g.archive_label || 'Earlier';
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(g);
      }
      fill(past,
        h('h2', null, '🗄️ Past gifts'),
        [...groups].map(([label, list]) => h('div', { class: 'card past-group' },
          h('div', { class: 'past-group-head' },
            h('h3', null, label),
            h('span', { class: 'person-sub' }, `${list.length} gift${list.length === 1 ? '' : 's'} · ${money(list.reduce((sum, g) => sum + g.price_cents, 0))}`)),
          h('ul', { class: 'past-list' }, list.map((g) => h('li', null,
            h('img', { src: g.image_url, alt: '', loading: 'lazy', class: g.image_source === 'product' ? 'product' : null }),
            h('div', { class: 'past-info' },
              h('div', { class: 'gift-name' }, g.name),
              h('div', { class: 'person-sub' },
                g.price_cents ? money(g.price_cents) : null,
                g.price_cents && g.url ? ' · ' : null,
                g.url ? h('a', { href: g.url, target: '_blank', rel: 'noopener noreferrer' }, hostname(g.url)) : null)),
            h('div', { class: 'past-actions' },
              h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: () => restoreGift(g), title: 'Move back to the current list' }, 'Restore'),
              h('button', {
                class: 'btn btn-ghost btn-sm btn-icon', type: 'button', 'aria-label': `Delete ${g.name}`, title: 'Delete',
                onclick: () => confirmDialog('Delete this past gift?', `“${g.name}” will be removed from Past gifts.`, 'Delete', async () => {
                  await api('DELETE', `/gifts/${g.id}`);
                  archived = archived.filter((x) => x.id !== g.id);
                  person.archived_count -= 1;
                  drawPast();
                }),
              }, '🗑️'),
            )))))),
      );
    }

    function drawGifts() {
      const shown = state.filter === 'all' ? gifts : gifts.filter((g) => g.status === state.filter);
      if (!gifts.length) {
        fill(grid, h('div', { class: 'card empty', style: { gridColumn: '1 / -1' } },
          h('div', { class: 'big' }, '💡'), h('h2', null, 'No gift ideas yet'), person.locked ? null : h('p', null, `Add your first idea for ${person.name} above.`)));
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
      drawPast();
    }

    state.filter = 'all';
    recompute();
    drawAll();
    fill(app,
      h('a', { class: 'back', href: '#/' }, '← Everyone'),
      header,
      person.locked
        ? h('section', { class: 'card locked-notice' },
          h('div', null,
            h('h2', null, '🔒 Read-only'),
            h('p', null, `Premium has ended, so you can only make changes for the first ${(state.billing || state.plans).free_people_limit} people you added. `
              + `Everything for ${person.name} is still here – upgrade again to edit it.`)),
          h('button', { class: 'btn btn-upgrade', type: 'button', onclick: showUpgrade }, '⭐ Upgrade'))
        : h('section', { class: 'card add-gift' }, h('h2', null, 'Add a gift idea'), addForm),
      filters,
      grid,
      past,
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
    document.getElementById('admin-link').hidden = !state.user.is_admin;
    const b = state.billing;
    const badge = document.getElementById('plan-badge');
    if (!b || !b.enabled) fill(badge);
    else if (b.premium) fill(badge, h('a', { class: 'plan-chip premium', href: '#/account' }, '⭐ Premium'));
    else fill(badge, h('button', { class: 'btn btn-sm btn-upgrade', type: 'button', onclick: showUpgrade }, '⭐ Upgrade'));
  }

  document.getElementById('logout-btn').addEventListener('click', async () => {
    await api('POST', '/auth/logout').catch(() => {});
    state.user = null;
    state.billing = null;
    location.hash = '#/';
    render();
  });

  document.addEventListener('click', () => {
    document.querySelectorAll('.menu-list').forEach((m) => { m.hidden = true; });
  });

  let previousHash = null;

  async function render() {
    if (modal.open) modal.close();
    drawTopbar();
    const [route, query = ''] = location.hash.slice(1).split('?');
    const params = new URLSearchParams(query);
    if (route === '/reset' && params.get('token')) return renderReset(params.get('token'));
    // The footer link opens the form over the page the person is already on.
    if (route === '/request-feature') {
      history.replaceState(null, '', previousHash || '#/');
      if (!app.hasChildNodes() || previousHash === null) await render();
      openFeatureRequest();
      return;
    }
    previousHash = location.hash || '#/';
    if (!state.user) return renderAuth();
    const match = route.match(/^\/people\/(\d+)$/);
    try {
      if (match) await renderPerson(match[1]);
      else if (route === '/account') await renderAccount(params);
      else if (route === '/admin' && state.user.is_admin) await renderAdmin();
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
  // Coming Back from Stripe can restore this page from the browser cache with a dialog still open.
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) render();
  });

  (async function boot() {
    try {
      const me = await api('GET', '/auth/me');
      state.user = me.user;
      state.currencies = me.currencies;
      if (me.plans) state.plans = me.plans;
      if (state.user) await refreshBilling();
    } catch {
      state.user = null;
    }
    render();
  })();
})();
