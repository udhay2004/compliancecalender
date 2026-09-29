// public/js/company-form.js
//
// The country-specific company questions (state or province, entity type,
// tax status, free zone, VAT/GST, payroll…), rendered from the one
// definition in lib/countries.js (GET /api/public/form). Used by the website
// generator (index.html), the staff generator (app.html) and the client
// portal's "Update details & regenerate" (portal.html), so every form asks
// the same questions and the server checks the same answers.
//
//   const def = await CompanyForm.load();
//   const form = CompanyForm.create(containerEl, def, { country, values, locked: ["state"] });
//   form.setCountry("Canada");
//   const check = form.validate();      // { ok } or { ok: false, message, key }
//   const answers = form.values();      // only the questions currently shown
//
// Fields are rendered as `.field` blocks directly inside the container, so
// they sit in the page's own grid (give the container display: contents).
(function () {
  'use strict';

  var loading = null;
  function load() {
    if (!loading) {
      loading = fetch('/api/public/form', { credentials: 'same-origin' })
        .then(function (r) { if (!r.ok) throw new Error('Could not load the form. Please refresh the page.'); return r.json(); })
        .catch(function (err) { loading = null; throw err; });
    }
    return loading;
  }

  var STYLE_ID = 'company-form-style';
  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = [
      '.cf-checks{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:2px 12px;max-height:190px;overflow:auto;padding:10px 12px;border:1px solid var(--rule,#DCE5E4);border-radius:10px;background:var(--card,#fff)}',
      '.cf-checks label{display:flex;align-items:center;gap:8px;font-size:13.5px;font-weight:500;padding:4px 0;cursor:pointer;margin:0;color:inherit}',
      '.cf-checks input{width:auto;min-height:0;height:auto;margin:0;box-shadow:none}',
      '.cf-yesno{display:inline-flex;border:1px solid var(--rule,#DCE5E4);border-radius:10px;overflow:hidden;align-self:flex-start}',
      '.cf-yesno label{display:flex;align-items:center;gap:6px;padding:10px 18px;font-size:14px;font-weight:600;cursor:pointer;margin:0;color:inherit}',
      '.cf-yesno label+label{border-left:1px solid var(--rule,#DCE5E4)}',
      '.cf-yesno input{width:auto;min-height:0;height:auto;margin:0;box-shadow:none;accent-color:var(--brand,#34A9A1)}',
      '.cf-yesno label:has(input:checked){background:var(--brand-tint,#E3F5F3)}',
      '.cf-locked{padding:11px 14px;border:1px dashed var(--rule,#DCE5E4);border-radius:10px;font-size:14px;font-weight:600}',
      '.cf-count{font-weight:500;color:var(--ink-soft,#5C6E72);font-size:12.5px;margin-left:6px}',
    ].join('\n');
    document.head.appendChild(s);
  }

  function el(tag, attrs, text) {
    var e = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === 'className') e.className = attrs[k];
      else if (attrs[k] !== undefined && attrs[k] !== null) e.setAttribute(k, attrs[k]);
    });
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function create(container, def, opts) {
    opts = opts || {};
    injectStyle();
    var prefix = opts.idPrefix || 'cf';
    var locked = opts.locked || [];
    var state = { country: opts.country || def.countries[0], answers: Object.assign({}, opts.values || {}) };

    function fields() { return def.fields[state.country] || []; }
    function optionsFor(f) {
      if (f.options) return f.options;
      return (f.optionsFrom.map[state.answers[f.optionsFrom.field]] || []);
    }
    function shown(f) {
      if (!f.showIf) return true;
      return Object.keys(f.showIf).every(function (k) { return f.showIf[k].indexOf(state.answers[k]) !== -1; });
    }
    function labelOf(f) {
      if (!f.labelFrom) return f.label;
      return f.labelFrom.map[state.answers[f.labelFrom.field]] || f.labelFrom.default;
    }
    function text(f, v) { return (f.optionLabels && f.optionLabels[v]) || v; }
    // A locked answer that isn't a valid option (older calendars) stays editable.
    function isLocked(f) {
      if (locked.indexOf(f.key) === -1) return false;
      var v = state.answers[f.key];
      return v !== undefined && v !== '' && (f.type !== 'select' || optionsFor(f).indexOf(v) !== -1);
    }

    // Drop answers that no longer fit (e.g. the free zone after changing emirate).
    function tidy() {
      fields().forEach(function (f) {
        var v = state.answers[f.key];
        if (!shown(f) || f.type === 'yesno' || f.type === 'text' || v === undefined || isLocked(f)) return;
        var allowed = optionsFor(f);
        if (f.type === 'multiselect') state.answers[f.key] = (v || []).filter(function (x) { return allowed.indexOf(x) !== -1; });
        else if (allowed.indexOf(v) === -1) delete state.answers[f.key];
      });
    }

    function render() {
      tidy();
      container.innerHTML = '';
      fields().forEach(function (f) {
        if (!shown(f)) return;
        var id = prefix + '-' + f.key;
        var wrap = el('div', { className: 'field' + (f.type === 'multiselect' ? ' span2' : ''), 'data-key': f.key });
        var labelText = labelOf(f) + (f.required || f.type === 'yesno' ? '' : ' (optional)');
        var value = state.answers[f.key];

        if (isLocked(f)) {
          wrap.appendChild(el('label', {}, labelOf(f)));
          wrap.appendChild(el('div', { className: 'cf-locked' }, Array.isArray(value) ? value.join(', ') : (value ? text(f, value) : '—')));
          wrap.appendChild(el('div', { className: 'field-hint' }, 'To change this, generate a calendar for another company.'));
          container.appendChild(wrap);
          return;
        }

        if (f.type === 'select') {
          wrap.appendChild(el('label', { for: id }, labelText));
          var sel = el('select', { id: id, 'aria-describedby': id + '-error' });
          var opts = optionsFor(f);
          if (!value || opts.indexOf(value) === -1) sel.appendChild(el('option', { value: '' }, 'Choose…'));
          opts.forEach(function (o) {
            var opt = el('option', { value: o }, text(f, o));
            if (o === value) opt.selected = true;
            sel.appendChild(opt);
          });
          sel.addEventListener('change', function () {
            if (sel.value) state.answers[f.key] = sel.value; else delete state.answers[f.key];
            clearError(f.key);
            render();
            var again = document.getElementById(id);
            if (again) again.focus();
          });
          wrap.appendChild(sel);
        } else if (f.type === 'yesno') {
          var gid = id + '-label';
          wrap.appendChild(el('label', { id: gid }, labelText));
          var group = el('div', { className: 'cf-yesno', role: 'radiogroup', 'aria-labelledby': gid });
          ['Yes', 'No'].forEach(function (o) {
            var lab = el('label');
            var r = el('input', { type: 'radio', name: id, value: o, id: id + '-' + o });
            if (value === o) r.checked = true;
            r.addEventListener('change', function () {
              state.answers[f.key] = o;
              clearError(f.key);
              render();
              var again = document.getElementById(id + '-' + o);
              if (again) again.focus();
            });
            lab.appendChild(r);
            lab.appendChild(document.createTextNode(o));
            group.appendChild(lab);
          });
          wrap.appendChild(group);
        } else if (f.type === 'multiselect') {
          var mid = id + '-label';
          var picked = Array.isArray(value) ? value : [];
          var head = el('label', { id: mid }, labelText);
          var count = el('span', { className: 'cf-count' }, picked.length ? picked.length + ' selected' : '');
          head.appendChild(count);
          wrap.appendChild(head);
          var box = el('div', { className: 'cf-checks', role: 'group', 'aria-labelledby': mid });
          optionsFor(f).forEach(function (o, i) {
            if (f.key === 'employeeStates' && o === state.answers.state) return;
            if (f.key === 'operatingRegions' && o === state.answers.state) return;
            var lab = el('label');
            var cb = el('input', { type: 'checkbox', value: o, id: id + '-' + i });
            if (picked.indexOf(o) !== -1) cb.checked = true;
            cb.addEventListener('change', function () {
              var cur = (state.answers[f.key] || []).filter(function (x) { return x !== o; });
              if (cb.checked) cur.push(o);
              state.answers[f.key] = cur;
              count.textContent = cur.length ? cur.length + ' selected' : '';
            });
            lab.appendChild(cb);
            lab.appendChild(document.createTextNode(text(f, o)));
            box.appendChild(lab);
          });
          wrap.appendChild(box);
        }
        if (f.help) wrap.appendChild(el('div', { className: 'field-hint' }, f.help));
        wrap.appendChild(el('div', { className: 'field-error', id: id + '-error', role: 'alert' }));
        container.appendChild(wrap);
      });
    }

    function clearError(key) {
      var e = document.getElementById(prefix + '-' + key + '-error');
      if (e) e.textContent = '';
    }

    function values() {
      var out = {};
      fields().forEach(function (f) {
        if (!shown(f)) return;
        var v = state.answers[f.key];
        if (f.type === 'multiselect') out[f.key] = (v || []).filter(function (x) { return x !== state.answers.state; });
        else if (v !== undefined && v !== '') out[f.key] = v;
      });
      return out;
    }

    function validate() {
      var fs = fields();
      for (var i = 0; i < fs.length; i++) {
        var f = fs[i];
        if (!shown(f) || !f.required || isLocked(f)) continue;
        var v = state.answers[f.key];
        if (v === undefined || v === '' || (f.type === 'yesno' && v !== 'Yes' && v !== 'No')) {
          var msg = 'Please answer: ' + labelOf(f) + '.';
          var err = document.getElementById(prefix + '-' + f.key + '-error');
          if (err) err.textContent = msg;
          var focusEl = document.getElementById(prefix + '-' + f.key) || document.getElementById(prefix + '-' + f.key + '-Yes');
          if (focusEl) focusEl.focus();
          return { ok: false, key: f.key, message: msg };
        }
      }
      return { ok: true };
    }

    render();
    return {
      setCountry: function (c) { state.country = c; render(); },
      country: function () { return state.country; },
      values: values,
      validate: validate,
      set: function (key, v) { state.answers[key] = v; render(); },
    };
  }

  window.CompanyForm = { load: load, create: create };
})();
