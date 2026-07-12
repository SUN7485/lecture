/*
 * theme.js — Theme file serialization: kit object <-> portable .theme.json.
 * Pure DOM, zero Electron APIs. Loaded verbatim by BOTH the Electron renderer
 * and the static web port — keep web/theme.js byte-identical to src/theme.js.
 * Reuses the SAME kit shape editor.applyThemeKit() already accepts
 * ({ name, fonts, varsCss|vars }) — this module only converts it to/from JSON.
 */
(function () {
  'use strict';

  var SCHEMA = 'lve.theme/2';
  var SCHEMA_V1 = 'lve.theme/1';

  // Parse a `:root{--a:val;--b:val2;}` block into { '--a': 'val', ... }.
  function parseVarsCss(varsCss) {
    var out = {};
    var m = /:root\s*\{([^}]*)\}/.exec(varsCss || '');
    if (!m) return out;
    m[1].split(';').forEach(function (decl) {
      var mm = /\s*(--[\w-]+)\s*:\s*(.+?)\s*$/.exec(decl);
      if (mm) out[mm[1]] = mm[2];
    });
    return out;
  }
  function varsToCss(vars) {
    var decls = Object.keys(vars || {}).map(function (k) { return k + ':' + vars[k] + ';'; }).join('');
    return decls ? ':root{' + decls + '}' : '';
  }

  // kit = { name, fonts:[{family,weight,style,ext,b64}], varsCss | vars, logo? }
  // -> plain object matching schema lve.theme/1.
  function serialize(kit) {
    kit = kit || {};
    var palette = kit.vars || parseVarsCss(kit.varsCss);
    var fonts = (kit.fonts || []).map(function (f) {
      return { family: f.family, weight: f.weight || 400, ext: f.ext || 'otf', b64: f.b64 };
    });
    var out = { schema: SCHEMA, name: kit.name || 'custom', palette: palette, fonts: fonts };
    if (kit.typography && (kit.typography.heading || kit.typography.body)) out.typography = kit.typography;
    if (kit.logo) out.logo = kit.logo;
    return out;
  }
  function toJson(kit) { return JSON.stringify(serialize(kit), null, 2); }

  // jsonString -> kit object suitable for editor.applyThemeKit(kit).
  function parse(jsonString) {
    var obj = JSON.parse(jsonString);
    if (!obj || (obj.schema !== SCHEMA && obj.schema !== SCHEMA_V1)) {
      throw new Error('Unsupported theme file (expected schema "' + SCHEMA + '", got "' + (obj && obj.schema) + '")');
    }
    var kit = { name: obj.name || 'custom', fonts: obj.fonts || [], varsCss: varsToCss(obj.palette) };
    if (obj.typography) {
      kit.typography = obj.typography;
      kit.varsCss += '\n' + typographyCss(obj.typography);
    }
    if (obj.logo) kit.logo = obj.logo;
    return kit;
  }

  // Role CSS for a typography assignment { heading:{family}, body:{family} }.
  // Includes the .slide-scoped selector forms so a later kit block beats the
  // built-in presets' own .slide rules by cascade order. The marker comments
  // let the app strip and re-append the block idempotently.
  function typographyCss(t) {
    if (!t) return '';
    var css = '/*ve-typo*/\n';
    if (t.body && t.body.family) {
      css += 'body, p, li, td, th, figcaption, blockquote, .slide .content, .slide p, .slide li' +
        ' { font-family: \'' + t.body.family + '\', sans-serif; }\n';
    }
    if (t.heading && t.heading.family) {
      css += 'h1, h2, h3, h4, .slide h1, .slide h2, .slide h3' +
        ' { font-family: \'' + t.heading.family + '\', sans-serif; }\n';
    }
    return css + '/*/ve-typo*/';
  }

  window.ThemeIO = { serialize: serialize, toJson: toJson, parse: parse, parseVarsCss: parseVarsCss, varsToCss: varsToCss, typographyCss: typographyCss };
})();
