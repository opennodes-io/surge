import type { WebContentsView } from 'electron';
import type { ToolDefinition } from '@surge/core/mcp';

/**
 * BrowserService — gives the AI model Playwright-like abilities to interact
 * with conventional web pages loaded in Surge's embedded browser view.
 *
 * Also detects MCP-B (browser-native MCPWeb) tools registered via
 * navigator.modelContext.registerTool() on the current page.
 *
 * Core tools:
 *   browser__getPageContent     — Extract readable text from the page
 *   browser__getPageMetadata    — Get title, URL, meta, headings, counts
 *   browser__navigateTo         — Navigate to a URL
 *   browser__clickElement       — Click by CSS selector
 *   browser__fillInput          — Type into a form field
 *   browser__getLinks           — Get all links on the page
 *   browser__getFormFields      — Get all form inputs
 *   browser__evaluateScript     — Run arbitrary JS
 *   browser__scrollPage         — Scroll up/down/to element
 *   browser__getSelectedText    — Get highlighted text
 *
 * Playwright-like tools:
 *   browser__waitForSelector    — Wait for an element to appear
 *   browser__selectOption       — Select dropdown option
 *   browser__checkElement       — Check/uncheck checkbox or radio
 *   browser__hoverElement       — Hover over an element
 *   browser__getElementText     — Get innerText of a specific element
 *   browser__getElementAttribute — Get an attribute of an element
 *   browser__getTableData       — Extract structured table data as JSON
 *   browser__waitForNavigation  — Wait until URL changes
 *   browser__pressKey           — Press a keyboard key
 *
 * MCP-B tools:
 *   browser__detectMcpBTools    — Detect navigator.modelContext tools on page
 *   browser__callMcpBTool       — Call a registered MCP-B tool
 */
export class BrowserService {
  private viewGetter: () => WebContentsView | null;

  constructor(viewGetter: () => WebContentsView | null) {
    this.viewGetter = viewGetter;
  }

  private get wc() {
    return this.viewGetter()?.webContents ?? null;
  }

  // ── Tool Definitions (OpenAI function-calling format) ───
  getToolDefinitions(): ToolDefinition[] {
    return [
      // ── Core Browser Tools ─────────────────────────────
      {
        type: 'function',
        function: {
          name: 'browser__getPageContent',
          description: '[Browser] Extract the main readable text content from the current web page.',
          parameters: {
            type: 'object',
            properties: {
              maxLength: { type: 'number', description: 'Maximum characters to return (default 8000)' },
            },
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'browser__getPageMetadata',
          description: '[Browser] Get metadata about the current page: title, URL, meta description, headings, link/image/form counts.',
          parameters: { type: 'object', properties: {} },
        },
      },
      {
        type: 'function',
        function: {
          name: 'browser__navigateTo',
          description: '[Browser] Navigate the browser to a new URL.',
          parameters: {
            type: 'object',
            properties: {
              url: { type: 'string', description: 'The URL to navigate to' },
            },
            required: ['url'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'browser__clickElement',
          description: '[Browser] Click an element using a CSS selector. Use for buttons, links, or interactive elements.',
          parameters: {
            type: 'object',
            properties: {
              selector: { type: 'string', description: 'CSS selector (e.g., "button.submit", "#login-btn")' },
            },
            required: ['selector'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'browser__fillInput',
          description: '[Browser] Type text into an input field. Fires input/change events for React/Vue compatibility.',
          parameters: {
            type: 'object',
            properties: {
              selector: { type: 'string', description: 'CSS selector of the input field' },
              value: { type: 'string', description: 'Text to type' },
              submit: { type: 'boolean', description: 'Whether to submit the form after filling (default false)' },
            },
            required: ['selector', 'value'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'browser__getLinks',
          description: '[Browser] Get all links on the page with their text and href.',
          parameters: {
            type: 'object',
            properties: {
              maxResults: { type: 'number', description: 'Max links to return (default 50)' },
              filter: { type: 'string', description: 'Only return links containing this text' },
            },
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'browser__getFormFields',
          description: '[Browser] Get all form inputs, selects, and textareas with type, name, id, placeholder, value, and CSS selector.',
          parameters: { type: 'object', properties: {} },
        },
      },
      {
        type: 'function',
        function: {
          name: 'browser__evaluateScript',
          description: '[Browser] Execute JavaScript in the page context and return the result.',
          parameters: {
            type: 'object',
            properties: {
              script: { type: 'string', description: 'JavaScript code to execute' },
            },
            required: ['script'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'browser__scrollPage',
          description: '[Browser] Scroll the page up, down, to top/bottom, or to a specific element.',
          parameters: {
            type: 'object',
            properties: {
              direction: { type: 'string', enum: ['up', 'down', 'top', 'bottom'], description: 'Scroll direction' },
              pixels: { type: 'number', description: 'Pixels to scroll (default 500)' },
              selector: { type: 'string', description: 'CSS selector to scroll to instead' },
            },
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'browser__getSelectedText',
          description: '[Browser] Get the text the user has currently selected/highlighted.',
          parameters: { type: 'object', properties: {} },
        },
      },
      // ── Playwright-Like Tools ──────────────────────────
      {
        type: 'function',
        function: {
          name: 'browser__waitForSelector',
          description: '[Browser] Wait for an element matching a CSS selector to appear. Useful after clicking a button that loads content.',
          parameters: {
            type: 'object',
            properties: {
              selector: { type: 'string', description: 'CSS selector to wait for' },
              timeoutMs: { type: 'number', description: 'Max wait time in ms (default 5000)' },
            },
            required: ['selector'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'browser__selectOption',
          description: '[Browser] Select an option in a <select> dropdown by value or visible text.',
          parameters: {
            type: 'object',
            properties: {
              selector: { type: 'string', description: 'CSS selector of the <select>' },
              value: { type: 'string', description: 'Option value or visible text to select' },
            },
            required: ['selector', 'value'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'browser__checkElement',
          description: '[Browser] Check or uncheck a checkbox or radio button.',
          parameters: {
            type: 'object',
            properties: {
              selector: { type: 'string', description: 'CSS selector of the checkbox/radio' },
              checked: { type: 'boolean', description: 'Check (true) or uncheck (false). Default: true' },
            },
            required: ['selector'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'browser__hoverElement',
          description: '[Browser] Hover over an element to trigger tooltips, menus, or hover effects.',
          parameters: {
            type: 'object',
            properties: {
              selector: { type: 'string', description: 'CSS selector of the element' },
            },
            required: ['selector'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'browser__getElementText',
          description: '[Browser] Get the innerText of a specific element.',
          parameters: {
            type: 'object',
            properties: {
              selector: { type: 'string', description: 'CSS selector' },
            },
            required: ['selector'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'browser__getElementAttribute',
          description: '[Browser] Get a specific attribute value from an element (href, src, data-*, aria-*).',
          parameters: {
            type: 'object',
            properties: {
              selector: { type: 'string', description: 'CSS selector' },
              attribute: { type: 'string', description: 'Attribute name (e.g., "href", "src", "data-id")' },
            },
            required: ['selector', 'attribute'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'browser__getTableData',
          description: '[Browser] Extract data from an HTML <table> as structured JSON with headers and rows.',
          parameters: {
            type: 'object',
            properties: {
              selector: { type: 'string', description: 'CSS selector of the table (default: first table)' },
              maxRows: { type: 'number', description: 'Max rows to return (default 100)' },
            },
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'browser__waitForNavigation',
          description: '[Browser] Wait for page navigation to complete (URL change). Use after clicking a link or submitting a form.',
          parameters: {
            type: 'object',
            properties: {
              timeoutMs: { type: 'number', description: 'Max wait time in ms (default 10000)' },
            },
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'browser__pressKey',
          description: '[Browser] Press a keyboard key (Enter, Escape, Tab, ArrowDown, etc.).',
          parameters: {
            type: 'object',
            properties: {
              key: { type: 'string', description: 'Key to press: "Enter", "Escape", "Tab", "ArrowDown", etc.' },
              selector: { type: 'string', description: 'Optional: element to focus before pressing' },
              modifiers: { type: 'string', description: 'Optional: "ctrl", "shift", "alt" (comma-separated)' },
            },
            required: ['key'],
          },
        },
      },
      // ── MCP-B (Browser-Native MCPWeb) Tools ────────────
      {
        type: 'function',
        function: {
          name: 'browser__detectMcpBTools',
          description: '[Browser] Detect MCP-B tools registered via navigator.modelContext on the current page. Returns tool names and schemas.',
          parameters: { type: 'object', properties: {} },
        },
      },
      {
        type: 'function',
        function: {
          name: 'browser__callMcpBTool',
          description: '[Browser] Call an MCP-B tool registered on the current page. Use browser__detectMcpBTools first to discover available tools.',
          parameters: {
            type: 'object',
            properties: {
              toolName: { type: 'string', description: 'Name of the MCP-B tool to call' },
              args: { type: 'object', description: 'Arguments to pass to the tool' },
            },
            required: ['toolName'],
          },
        },
      },
    ];
  }

  // ── System Prompt Section ──────────────────────────────
  async getContextPrompt(): Promise<string> {
    const wc = this.wc;
    if (!wc || !wc.getURL()) return '';

    const url = wc.getURL();
    const title = wc.getTitle();

    // Check for MCP-B tools on the page
    let mcpbInfo = '';
    try {
      const hasMcpB = await wc.executeJavaScript(`
        typeof navigator !== 'undefined' && navigator.modelContext !== undefined
      `);
      if (hasMcpB) {
        mcpbInfo = '\n- **MCP-B**: This page has browser-native MCP tools. Use `browser__detectMcpBTools` to discover them and `browser__callMcpBTool` to use them.';
      }
    } catch {
      // Ignore
    }

    return [
      '',
      '## Browser Context',
      `The user has a web page open in the browser:`,
      `- **URL**: ${url}`,
      `- **Title**: ${title}`,
      mcpbInfo,
      '',
      'You have Playwright-like browser tools (prefixed with browser__) to read, navigate, and interact with this page.',
      'Key tools: getPageContent (read), clickElement (click), fillInput (type), navigateTo (navigate),',
      'getTableData (tables), waitForSelector (wait), selectOption (dropdowns), pressKey (keyboard).',
      'For MCP-B pages: detectMcpBTools (discover), callMcpBTool (execute site AI actions).',
      '',
    ].join('\n');
  }

  // ── Tool Execution ─────────────────────────────────────
  async executeTool(toolName: string, args: Record<string, any>): Promise<string> {
    const wc = this.wc;
    if (!wc) return 'Error: No browser view is currently active.';
    // executeJavaScript on a view that never loaded a page never settles: answer instead of hanging the chat.
    if (!wc.getURL() && toolName !== 'navigateTo') {
      return 'Error: No page is open in the browser. Use browser__navigateTo first, or answer without the page.';
    }
    // Every tool answers within its own wait plus a margin, so a stuck page can't stall the tool loop.
    const limitMs = Math.max(15_000, Number(args.timeoutMs ?? 0) + 5_000);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<string>((resolve) => {
      timer = setTimeout(() => resolve(`Error: browser__${toolName} did not finish within ${limitMs / 1000}s.`), limitMs);
    });
    return Promise.race([this.dispatchTool(toolName, args), timeout]).finally(() => clearTimeout(timer));
  }

  private async dispatchTool(toolName: string, args: Record<string, any>): Promise<string> {
    switch (toolName) {
      // Core
      case 'getPageContent': return this.getPageContent(args.maxLength ?? 8000);
      case 'getPageMetadata': return this.getPageMetadata();
      case 'navigateTo': return this.navigateTo(args.url);
      case 'clickElement': return this.clickElement(args.selector);
      case 'fillInput': return this.fillInput(args.selector, args.value, args.submit ?? false);
      case 'getLinks': return this.getLinks(args.maxResults ?? 50, args.filter);
      case 'getFormFields': return this.getFormFields();
      case 'evaluateScript': return this.evaluateScript(args.script);
      case 'scrollPage': return this.scrollPage(args.direction, args.pixels, args.selector);
      case 'getSelectedText': return this.getSelectedText();
      // Playwright-like
      case 'waitForSelector': return this.waitForSelector(args.selector, args.timeoutMs ?? 5000);
      case 'selectOption': return this.selectOption(args.selector, args.value);
      case 'checkElement': return this.checkElement(args.selector, args.checked ?? true);
      case 'hoverElement': return this.hoverElement(args.selector);
      case 'getElementText': return this.getElementText(args.selector);
      case 'getElementAttribute': return this.getElementAttribute(args.selector, args.attribute);
      case 'getTableData': return this.getTableData(args.selector, args.maxRows ?? 100);
      case 'waitForNavigation': return this.waitForNavigation(args.timeoutMs ?? 10000);
      case 'pressKey': return this.pressKey(args.key, args.selector, args.modifiers);
      // MCP-B
      case 'detectMcpBTools': return this.detectMcpBTools();
      case 'callMcpBTool': return this.callMcpBTool(args.toolName, args.args ?? {});
      default: return `Error: Unknown browser tool "${toolName}"`;
    }
  }

  // ── Core Implementation ─────────────────────────────────

  private async getPageContent(maxLength: number): Promise<string> {
    const wc = this.wc;
    if (!wc) return 'No page loaded.';
    try {
      const text = await wc.executeJavaScript(`
        (function() {
          const clone = document.body.cloneNode(true);
          clone.querySelectorAll('script, style, noscript, svg, nav, footer, header, [aria-hidden="true"]').forEach(el => el.remove());
          function extract(node, depth) {
            if (depth > 20) return '';
            let text = '';
            for (const child of node.childNodes) {
              if (child.nodeType === 3) { const t = child.textContent.trim(); if (t) text += t + ' '; }
              else if (child.nodeType === 1) {
                const tag = child.tagName;
                if (['H1','H2','H3','H4','H5','H6'].includes(tag)) text += '\\n\\n## ' + child.textContent.trim() + '\\n';
                else if (['P','DIV','SECTION','ARTICLE'].includes(tag)) text += '\\n' + extract(child, depth+1);
                else if (tag === 'LI') text += '\\n- ' + extract(child, depth+1);
                else if (tag === 'BR') text += '\\n';
                else text += extract(child, depth+1);
              }
            }
            return text;
          }
          return extract(clone, 0).replace(/\\n{3,}/g, '\\n\\n').trim().slice(0, ${maxLength});
        })()
      `);
      return text || 'Page appears empty.';
    } catch (err: any) { return `Error extracting page content: ${err.message}`; }
  }

  private async getPageMetadata(): Promise<string> {
    const wc = this.wc;
    if (!wc) return 'No page loaded.';
    try {
      return await wc.executeJavaScript(`
        (function() {
          const headings = Array.from(document.querySelectorAll('h1, h2, h3')).slice(0, 20).map(h => ({ level: h.tagName, text: h.textContent.trim().slice(0, 100) }));
          return JSON.stringify({ title: document.title, url: location.href,
            description: document.querySelector('meta[name="description"]')?.content || '',
            headings, linkCount: document.querySelectorAll('a[href]').length,
            imageCount: document.querySelectorAll('img').length,
            formCount: document.querySelectorAll('form').length,
            inputCount: document.querySelectorAll('input, textarea, select').length });
        })()
      `);
    } catch (err: any) { return `Error: ${err.message}`; }
  }

  private async navigateTo(url: string): Promise<string> {
    const wc = this.wc;
    if (!wc) return 'No browser view active.';
    try {
      const fullUrl = url.startsWith('http') ? url : `https://${url}`;
      await wc.loadURL(fullUrl);
      await new Promise(r => setTimeout(r, 1500));
      return `Navigated to: ${wc.getURL()} — Title: "${wc.getTitle()}"`;
    } catch (err: any) { return `Navigation error: ${err.message}`; }
  }

  private async clickElement(selector: string): Promise<string> {
    const wc = this.wc;
    if (!wc) return 'No browser view active.';
    try {
      return await wc.executeJavaScript(`
        (function() {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) return 'Element not found: ' + ${JSON.stringify(selector)};
          el.click();
          return 'Clicked: ' + (el.tagName || '') + ' ' + (el.textContent || '').trim().slice(0, 60);
        })()
      `);
    } catch (err: any) { return `Error clicking element: ${err.message}`; }
  }

  private async fillInput(selector: string, value: string, submit: boolean): Promise<string> {
    const wc = this.wc;
    if (!wc) return 'No browser view active.';
    try {
      return await wc.executeJavaScript(`
        (function() {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) return 'Input not found: ' + ${JSON.stringify(selector)};
          const nativeSet = Object.getOwnPropertyDescriptor(
            el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value'
          )?.set;
          if (nativeSet) nativeSet.call(el, ${JSON.stringify(value)});
          else el.value = ${JSON.stringify(value)};
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          if (${submit}) {
            const form = el.closest('form');
            if (form) { form.requestSubmit ? form.requestSubmit() : form.submit(); return 'Filled and submitted form'; }
            return 'Filled input (no parent form to submit)';
          }
          return 'Filled input: ' + (el.name || el.id || el.placeholder || ${JSON.stringify(selector)});
        })()
      `);
    } catch (err: any) { return `Error filling input: ${err.message}`; }
  }

  private async getLinks(maxResults: number, filter?: string): Promise<string> {
    const wc = this.wc;
    if (!wc) return 'No page loaded.';
    try {
      const filterExpr = filter
        ? `.filter(l => l.text.toLowerCase().includes(${JSON.stringify(filter.toLowerCase())}) || l.href.toLowerCase().includes(${JSON.stringify(filter.toLowerCase())}))`
        : '';
      return await wc.executeJavaScript(`
        (function() {
          return JSON.stringify(Array.from(document.querySelectorAll('a[href]'))
            .map(a => ({ text: a.textContent.trim().slice(0, 80), href: a.href }))
            .filter(l => l.text && l.href && !l.href.startsWith('javascript:'))
            ${filterExpr}.slice(0, ${maxResults}));
        })()
      `);
    } catch (err: any) { return `Error: ${err.message}`; }
  }

  private async getFormFields(): Promise<string> {
    const wc = this.wc;
    if (!wc) return 'No page loaded.';
    try {
      return await wc.executeJavaScript(`
        (function() {
          return JSON.stringify(Array.from(document.querySelectorAll('input, textarea, select')).map(el => ({
            tag: el.tagName.toLowerCase(), type: el.type || '', name: el.name || '',
            id: el.id || '', placeholder: el.placeholder || '', value: el.value?.slice(0, 50) || '',
            selector: el.id ? '#' + el.id : (el.name ? el.tagName.toLowerCase() + '[name="' + el.name + '"]' : ''),
          })));
        })()
      `);
    } catch (err: any) { return `Error: ${err.message}`; }
  }

  private async evaluateScript(script: string): Promise<string> {
    const wc = this.wc;
    if (!wc) return 'No browser view active.';
    try {
      const result = await wc.executeJavaScript(script);
      if (result === undefined || result === null) return 'undefined';
      if (typeof result === 'object') return JSON.stringify(result, null, 2);
      return String(result);
    } catch (err: any) { return `Script error: ${err.message}`; }
  }

  private async scrollPage(direction?: string, pixels?: number, selector?: string): Promise<string> {
    const wc = this.wc;
    if (!wc) return 'No browser view active.';
    try {
      if (selector) {
        await wc.executeJavaScript(`document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({ behavior: 'smooth', block: 'center' })`);
        return `Scrolled to element: ${selector}`;
      }
      const px = pixels ?? 500;
      switch (direction) {
        case 'top': await wc.executeJavaScript('window.scrollTo({ top: 0, behavior: "smooth" })'); return 'Scrolled to top';
        case 'bottom': await wc.executeJavaScript('window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" })'); return 'Scrolled to bottom';
        case 'up': await wc.executeJavaScript(`window.scrollBy({ top: -${px}, behavior: "smooth" })`); return `Scrolled up ${px}px`;
        default: await wc.executeJavaScript(`window.scrollBy({ top: ${px}, behavior: "smooth" })`); return `Scrolled down ${px}px`;
      }
    } catch (err: any) { return `Scroll error: ${err.message}`; }
  }

  private async getSelectedText(): Promise<string> {
    const wc = this.wc;
    if (!wc) return 'No browser view active.';
    try {
      const text = await wc.executeJavaScript('window.getSelection()?.toString() || ""');
      return text || 'No text selected.';
    } catch (err: any) { return `Error: ${err.message}`; }
  }

  // ── Playwright-Like Implementation ──────────────────────

  private async waitForSelector(selector: string, timeoutMs: number): Promise<string> {
    const wc = this.wc;
    if (!wc) return 'No browser view active.';
    try {
      const result = await wc.executeJavaScript(`
        new Promise((resolve) => {
          const existing = document.querySelector(${JSON.stringify(selector)});
          if (existing) { resolve('found'); return; }
          const observer = new MutationObserver(() => {
            if (document.querySelector(${JSON.stringify(selector)})) { observer.disconnect(); resolve('found'); }
          });
          observer.observe(document.body, { childList: true, subtree: true });
          setTimeout(() => { observer.disconnect(); resolve('timeout'); }, ${timeoutMs});
        })
      `);
      if (result === 'found') {
        const text = await wc.executeJavaScript(`(document.querySelector(${JSON.stringify(selector)})?.textContent || '').trim().slice(0, 100)`);
        return `Element found: ${selector} — "${text}"`;
      }
      return `Timeout: element "${selector}" did not appear within ${timeoutMs}ms`;
    } catch (err: any) { return `Error: ${err.message}`; }
  }

  private async selectOption(selector: string, value: string): Promise<string> {
    const wc = this.wc;
    if (!wc) return 'No browser view active.';
    try {
      return await wc.executeJavaScript(`
        (function() {
          const sel = document.querySelector(${JSON.stringify(selector)});
          if (!sel || sel.tagName !== 'SELECT') return 'Select element not found: ' + ${JSON.stringify(selector)};
          let found = false;
          for (const opt of sel.options) {
            if (opt.value === ${JSON.stringify(value)} || opt.textContent.trim() === ${JSON.stringify(value)}) {
              sel.value = opt.value; found = true; break;
            }
          }
          if (!found) return 'Option not found: ' + ${JSON.stringify(value)} + '. Available: ' + Array.from(sel.options).map(o => o.textContent.trim()).join(', ');
          sel.dispatchEvent(new Event('change', { bubbles: true }));
          return 'Selected: ' + ${JSON.stringify(value)} + ' in ' + (sel.name || sel.id || ${JSON.stringify(selector)});
        })()
      `);
    } catch (err: any) { return `Error: ${err.message}`; }
  }

  private async checkElement(selector: string, checked: boolean): Promise<string> {
    const wc = this.wc;
    if (!wc) return 'No browser view active.';
    try {
      return await wc.executeJavaScript(`
        (function() {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) return 'Element not found: ' + ${JSON.stringify(selector)};
          if (el.type !== 'checkbox' && el.type !== 'radio') return 'Not a checkbox or radio: ' + el.type;
          el.checked = ${checked};
          el.dispatchEvent(new Event('change', { bubbles: true }));
          el.dispatchEvent(new Event('input', { bubbles: true }));
          return '${checked ? 'Checked' : 'Unchecked'}: ' + (el.name || el.id || ${JSON.stringify(selector)});
        })()
      `);
    } catch (err: any) { return `Error: ${err.message}`; }
  }

  private async hoverElement(selector: string): Promise<string> {
    const wc = this.wc;
    if (!wc) return 'No browser view active.';
    try {
      return await wc.executeJavaScript(`
        (function() {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) return 'Element not found: ' + ${JSON.stringify(selector)};
          el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
          el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
          return 'Hovered: ' + (el.tagName || '') + ' ' + (el.textContent || '').trim().slice(0, 60);
        })()
      `);
    } catch (err: any) { return `Error: ${err.message}`; }
  }

  private async getElementText(selector: string): Promise<string> {
    const wc = this.wc;
    if (!wc) return 'No browser view active.';
    try {
      return await wc.executeJavaScript(`document.querySelector(${JSON.stringify(selector)})?.innerText || 'Element not found'`);
    } catch (err: any) { return `Error: ${err.message}`; }
  }

  private async getElementAttribute(selector: string, attribute: string): Promise<string> {
    const wc = this.wc;
    if (!wc) return 'No browser view active.';
    try {
      return await wc.executeJavaScript(`
        (function() {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) return 'Element not found';
          return el.getAttribute(${JSON.stringify(attribute)}) ?? 'Attribute not found';
        })()
      `);
    } catch (err: any) { return `Error: ${err.message}`; }
  }

  private async getTableData(selector?: string, maxRows: number = 100): Promise<string> {
    const wc = this.wc;
    if (!wc) return 'No browser view active.';
    try {
      return await wc.executeJavaScript(`
        (function() {
          const table = document.querySelector(${JSON.stringify(selector || 'table')});
          if (!table) return JSON.stringify({ error: 'No table found' });
          const headers = Array.from(table.querySelectorAll('thead th, thead td, tr:first-child th, tr:first-child td')).map(th => th.textContent.trim());
          const rows = [];
          const bodyRows = table.querySelectorAll('tbody tr, tr');
          const startIdx = headers.length > 0 && !table.querySelector('thead') ? 1 : 0;
          for (let i = startIdx; i < Math.min(bodyRows.length, ${maxRows} + startIdx); i++) {
            const cells = Array.from(bodyRows[i].querySelectorAll('td, th')).map(td => td.textContent.trim());
            if (cells.length > 0) rows.push(cells);
          }
          return JSON.stringify({ headers, rows, totalRows: bodyRows.length - startIdx });
        })()
      `);
    } catch (err: any) { return `Error: ${err.message}`; }
  }

  private async waitForNavigation(timeoutMs: number): Promise<string> {
    const wc = this.wc;
    if (!wc) return 'No browser view active.';
    const startUrl = wc.getURL();
    try {
      await new Promise<void>((resolve) => {
        const check = setInterval(() => {
          if (wc.getURL() !== startUrl) { clearInterval(check); resolve(); }
        }, 200);
        setTimeout(() => { clearInterval(check); resolve(); }, timeoutMs);
      });
      await new Promise(r => setTimeout(r, 500));
      const newUrl = wc.getURL();
      return newUrl !== startUrl
        ? `Navigation complete: ${newUrl} — Title: "${wc.getTitle()}"`
        : `No navigation occurred within ${timeoutMs}ms. Still on: ${startUrl}`;
    } catch (err: any) { return `Error: ${err.message}`; }
  }

  private async pressKey(key: string, selector?: string, modifiers?: string): Promise<string> {
    const wc = this.wc;
    if (!wc) return 'No browser view active.';
    try {
      if (selector) {
        await wc.executeJavaScript(`document.querySelector(${JSON.stringify(selector)})?.focus()`);
      }
      await wc.executeJavaScript(`
        (function() {
          const target = ${selector ? `document.querySelector(${JSON.stringify(selector)})` : 'document.activeElement'} || document.body;
          const mods = ${JSON.stringify((modifiers || '').toLowerCase().split(',').map(m => m.trim()).filter(Boolean))};
          const opts = { key: ${JSON.stringify(key)}, bubbles: true, ctrlKey: mods.includes('ctrl'), shiftKey: mods.includes('shift'), altKey: mods.includes('alt') };
          target.dispatchEvent(new KeyboardEvent('keydown', opts));
          target.dispatchEvent(new KeyboardEvent('keyup', opts));
          if (${JSON.stringify(key.toLowerCase())} === 'enter') target.dispatchEvent(new KeyboardEvent('keypress', opts));
        })()
      `);
      return `Pressed key: ${key}${selector ? ` on ${selector}` : ''}${modifiers ? ` (${modifiers})` : ''}`;
    } catch (err: any) { return `Error: ${err.message}`; }
  }

  // ── MCP-B (Browser-Native) Implementation ───────────────

  private async detectMcpBTools(): Promise<string> {
    const wc = this.wc;
    if (!wc) return 'No browser view active.';
    try {
      return await wc.executeJavaScript(`
        (function() {
          // Check for navigator.modelContext (MCP-B standard)
          if (typeof navigator === 'undefined' || !navigator.modelContext) {
            return JSON.stringify({ supported: false, message: 'No MCP-B support (navigator.modelContext not available)' });
          }
          const mc = navigator.modelContext;
          const tools = [];
          // mc.tools map
          if (mc.tools && typeof mc.tools === 'object') {
            for (const [name, tool] of Object.entries(mc.tools)) {
              tools.push({ name, description: tool.description || '', schema: tool.schema || tool.inputSchema || null });
            }
          }
          // mc.getTools() fallback
          if (tools.length === 0 && typeof mc.getTools === 'function') {
            try {
              const registered = mc.getTools();
              if (Array.isArray(registered)) {
                for (const tool of registered) {
                  tools.push({ name: tool.name, description: tool.description || '', schema: tool.schema || tool.inputSchema || null });
                }
              }
            } catch(e) {}
          }
          // __MCP_TOOLS__ global fallback (some polyfills)
          if (tools.length === 0 && window.__MCP_TOOLS__) {
            for (const [name, tool] of Object.entries(window.__MCP_TOOLS__)) {
              tools.push({ name, description: tool.description || '', schema: tool.schema || tool.inputSchema || null });
            }
          }
          return JSON.stringify({ supported: true, toolCount: tools.length, tools });
        })()
      `);
    } catch (err: any) { return `Error detecting MCP-B tools: ${err.message}`; }
  }

  private async callMcpBTool(toolName: string, args: Record<string, any>): Promise<string> {
    const wc = this.wc;
    if (!wc) return 'No browser view active.';
    try {
      return await wc.executeJavaScript(`
        (async function() {
          if (!navigator.modelContext) return JSON.stringify({ error: 'navigator.modelContext not available' });
          const mc = navigator.modelContext;
          try {
            // Standard: mc.callTool(name, args)
            if (typeof mc.callTool === 'function') {
              const result = await mc.callTool(${JSON.stringify(toolName)}, ${JSON.stringify(args)});
              return JSON.stringify({ success: true, result });
            }
            // Alternative: mc.tools[name].execute(args)
            if (mc.tools && mc.tools[${JSON.stringify(toolName)}]) {
              const tool = mc.tools[${JSON.stringify(toolName)}];
              if (typeof tool.execute === 'function') {
                const result = await tool.execute(${JSON.stringify(args)});
                return JSON.stringify({ success: true, result });
              }
              if (typeof tool.handler === 'function') {
                const result = await tool.handler(${JSON.stringify(args)});
                return JSON.stringify({ success: true, result });
              }
            }
            return JSON.stringify({ error: 'Tool not found or not callable: ' + ${JSON.stringify(toolName)} });
          } catch(e) {
            return JSON.stringify({ error: 'Tool execution failed: ' + e.message });
          }
        })()
      `);
    } catch (err: any) { return `Error calling MCP-B tool: ${err.message}`; }
  }
}
