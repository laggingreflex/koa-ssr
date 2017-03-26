const assert = require('assert');
const Path = require('path');
const URL = require('url');
const JSDOM = require('jsdom');
const vm = require('vm');
const cheerio = require('cheerio');
const fs = require('fs-promise');
const _ = require('lodash');
const delay = require('promise-delay');
const Debug = require('debug')
const helpers = require('./helpers');
const utils = require('./utils');

const debug = Debug('koa-ssr');
const debugJSDOM = Debug('koa-ssr:jsdom');
const debugJSDOMClient = Debug('koa-ssr:jsdom-client');

const readFile = _.memoize(f => fs.readFile(f, 'utf8'));
const readFileSync = _.memoize(f => fs.readFileSync(f, 'utf8'));

module.exports = function koaSSRmiddleware(root, opts) {

  assert(root, 'root directory is required to serve files');

  const readAsset = (a, sync) => readFile(Path.join(root, a));
  const readAssetSync = (a, sync) => readFileSync(Path.join(root, a));

  if (!opts) {
    opts = {}
  }

  if (!opts.index && !opts.html) {
    opts.index = 'index.html'
  }

  if (opts.index) {
    opts.html = readAssetSync(opts.index);
  }

  opts.timeout = opts.timeout || 5000;

  if ((!opts.cache && opts.cache !== false) || opts.cache === true) {
    opts.cache = {}
  }

  const inputHtmlDom = cheerio.load(opts.html);

  // Collect scripts
  const scripts = Array.from(inputHtmlDom('body script')).map(e => ({
    filename: e.attribs.src
  })).map(s => Object.assign(s, {
    code: readAssetSync(s.filename)
  })).map(s => (Object.assign(s, {
    script: new vm.Script(s.code, {
      filename: s.filename,
    })
  })));

  // remove script tags
  inputHtmlDom('body script').remove()

  // // Because JSDOM doesn't execute script with defer/async attribute: https://github.com/tmpvar/jsdom/issues?q=defer+OR+async
  // const modifiedScriptTags = {};
  // inputHtmlDom('body script').each((i, e) => {
  //   e = inputHtmlDom(e);
  //   if (e.attr('defer') || e.attr('async')) {
  //     modifiedScriptTags[e.attr('src')] = e.attr('defer') ? 'defer' : e.attr('async') ? 'async' : false;
  //     e.attr('defer', false)
  //     e.attr('async', false)
  //   }
  // });
  // debug({ modifiedScriptTags })

  const inputHtml = inputHtmlDom.html();
  debug('inputHtml:\n' + inputHtml)

  opts.jsdom = opts.jsdom || {};

  if (opts.console && opts.jsdom.virtualConsole) {
    throw new Error('Provide either `opts.console` or `opts.jsdom.virtualConsole`, not both');
  }

  const JSDOMVirtualConsole = JSDOM.createVirtualConsole().sendTo(utils.createJSDOMVirtualConsole(opts.console || debugJSDOMClient, Boolean(opts.console)));

  opts.modulesLoadedEventLabel = 'onModulesLoaded'

  opts.render = opts.render || ((ctx, html) => ctx.body = html);

  if (opts.resourceLoader && opts.jsdom.resourceLoader) {
    throw new Error('Provide either `opts.resourceLoader` or `opts.jsdom.resourceLoader`, not both');
  }

  const defaultJSDOMResourceLoader = (res, cb) => {
    debugJSDOM('Loading resource (default):', res.url.pathname);
    readFile(Path.join(root, res.url.pathname))
      .then(asset => {
        debugJSDOM('Loaded resource (default):', res.url.pathname);
        cb(null, asset);
      })
      .catch(err => {
        debugJSDOM(`Couldn't load resource (default):`, res.url.pathname);
        cb(err)
      });
  };

  opts.resourceLoader = opts.resourceLoader || ((res, cb, def) => def(res, cb));

  const JSDOMResourceLoader = (res, cb) => opts.resourceLoader(res, cb, (_res, _cb) => {
    if (_cb && _cb !== cb) {
      debugJSDOM('default resourceLoader callback intercepted')
    }
    if (_res && !_cb) {
      debugJSDOM('Warning: opts.resourceLoader partially called `def` (no callback). Using default')
    }
    defaultJSDOMResourceLoader(_res || res, _cb || cb)
  });

  return function koaSSR(ctx) {

    const fullUrl = ctx.protocol + '://' + ctx.host + ctx.originalUrl;
    debug({ fullUrl })

    return checkCache(invokeJSDOM);

    function checkCache(next) {
      if (opts.cache) {
        let cache
        if (typeof opts.cache === 'function') {
          cache = opts.cache(ctx)
        } else {
          cache = opts.cache[ctx.originalUrl]
        }
        if (cache) {
          if (cache.then) {
            return cache.then(cache => {
              if (cache) {
                return opts.render(ctx, cache)
              } else {
                return next();
              }
            })
          } else {
            return opts.render(ctx, cache);
          }
        } else {
          return next();
        }
      } else {
        return next();
      }
    }

    function invokeJSDOM() {
      debugJSDOM('Loading...')
      const startTime = new Date();
      const totalTime = () => (Date.now() - startTime) + 'ms';

      const jsdom = JSDOM.jsdom(inputHtml, Object.assign({
        features: {
          FetchExternalResources: ['script', 'link', 'css'],
          QuerySelector: true,
        },
        resourceLoader: JSDOMResourceLoader,
        virtualConsole: JSDOMVirtualConsole,
      }, opts.jsdom, {
        created: (err, window) => {
          if (err) {
            debugJSDOM('[on created] error', err)
            if (opts.jsdom.created) {
              opts.jsdom.created(err, window)
            } else {
              throw err
            }
          }
          debugJSDOM('[on created] ok')
          if (opts.jsdom.created) {
            opts.jsdom.created(err, window)
          }
        },
        onload: (window) => {
          debugJSDOM('[on onload] ok')
          if (opts.jsdom.onload) {
            opts.jsdom.onload(window)
          }
        },
        done: (err, window) => {
          if (err) {
            debugJSDOM('[on done] error', err)
            if (opts.jsdom.done) {
              opts.jsdom.done(err, window)
            } else {
              throw err
            }
          }
          debugJSDOM('[on done] ok')
          if (opts.jsdom.done) {
            opts.jsdom.done(err, window)
          }
        },
      }));
      debugJSDOM('loaded')

      const window = jsdom.defaultView;

      JSDOM.changeURL(window, fullUrl);
      debugJSDOM('URL changed to:', fullUrl)

      let resolve;
      const loaded = new Promise(r => resolve = r);

      window[opts.modulesLoadedEventLabel] = () => {
        resolve();
        loaded.loaded = true;
      };

      // debugJSDOM('Executing scripts...')
      // scripts.forEach((s) => {
      //   debugJSDOM('Executing', s.filename)
      //   JSDOM.evalVMScript(window, s.script)
      // });
      // debugJSDOM('Executed scripts')

      debugJSDOM('Executing scripts in a vm...')
      const sandbox = Object.assign({ window, global: window }, window);
      const context = vm.createContext(sandbox);
      scripts.forEach((s) => {
        debugJSDOM('Executing standalonw', s.filename)
        try {
          s.script.runInContext(context)
          Object.assign(sandbox, sandbox.window)

        } catch (error) {
          console.log(`runInContext`, error);
        }
      });
      debugJSDOM('Executed  standalonw scripts')

      return Promise.race([loaded, delay(opts.timeout)]).then(() => {
        debugJSDOM(opts.modulesLoadedEventLabel, 'fired in', totalTime());
        resolve();
        if (!loaded.loaded) {
          const err = new Error(`JSDOM Timed out (${parseInt(opts.timeout/1000, 10)}s), \`window.${opts.modulesLoadedEventLabel}\` was never called.`)
          err.koaSSR = { ctx, window };
          throw err;
        }

        // // restore modifiedScriptTags (async/defer)
        // for (const script of window.document.querySelectorAll('script')) {
        //   const src = URL.parse(script.src).path;
        //   if (src in modifiedScriptTags) {
        //     script.setAttribute(modifiedScriptTags[src], true);
        //   }
        // }
        // debugJSDOM(`restored modifiedScriptTags`);

        const preCache = JSDOM.serializeDocument(window.document);
        debugJSDOM(`serialized preCache`);

        let final;
        if (typeof opts.cache === 'function') {
          final = opts.cache(ctx, preCache, window, JSDOM.serializeDocument);
          assert(final, `opts.cache() didn't return anything`)
          if (final.then) {
            return final.then(final => {
              assert(final, `opts.cache() didn't resolve to anything`)
              if (typeof final !== 'string') {
                try {
                  final = JSDOM.serializeDocument(final.document);
                } catch (error) {
                  error.message = `Failed trying to serialize opts.cache()'s resolved object. ` + error.message;
                  throw error;
                }
              }
              debugJSDOM(`final opts.render in`, totalTime());
              return opts.render(ctx, final, window, JSDOM.serializeDocument)
            })
          } else {
            if (typeof final !== 'string') {
              try {
                final = JSDOM.serializeDocument(final.document);
              } catch (error) {
                error.message = `Failed trying to serialize opts.cache()'s returned object. ` + error.message;
                throw error;
              }
            }
            debugJSDOM(`final opts.render in`, totalTime());
            return opts.render(ctx, final, window, JSDOM.serializeDocument);
          }
        } else {
          final = preCache;
          if (opts.cache) {
            opts.cache[ctx.originalUrl] = final;
          }
          debugJSDOM(`final opts.render in`, totalTime());
          return opts.render(ctx, final, window, JSDOM.serializeDocument);
        }
      });
    }
  }
}

Object.assign(exports, helpers);
