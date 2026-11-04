/* Hive Commerce — core admin JS.
   Single IIFE: `const GH = (function(){ ... })();`. Historically split
   across views/js.php + views/js2.php, which were NOT independently
   valid JS — hence one file. Every other file in assets/js/ is a
   module that extends GH and must load after this one.
   Bootstrap values (ajax url, nonce) arrive on window.GHBoot, printed
   by wp_localize_script() in includes/assets.php. */
const GH = (function() {
    const AJAX  = (window.GHBoot && window.GHBoot.ajax)  || '';
    const NONCE = (window.GHBoot && window.GHBoot.nonce) || '';
    let state = { roundtripData:null, importJSON:null, bulkJSON:null };
    let _modalSeq = 0;   // unique ids for dialog aria-labelledby/describedby
    let taxTree=[], taxSelected=null, taxCollapsed={}, gsProducts=null, gsSelected=new Set(), gsDiffData=null;

    // ── Global ajax-in-flight progress bar ─────────────────────────
    // Lazily creates a 2px bar inside #gh and toggles .gh-loading on
    // body whenever there's at least one in-flight GH.ajax() call.
    // CSS does the heavy lifting (indeterminate sliding gradient).
    let inflight = 0;
    function ensureProgressBar() {
        if (document.getElementById('gh-progress')) return;
        const bar = document.createElement('div');
        bar.id = 'gh-progress';
        const host = document.getElementById('gh') || document.body;
        host.insertBefore(bar, host.firstChild);
    }
    function progressInc() {
        ensureProgressBar();
        inflight++;
        if (inflight === 1) document.body.classList.add('gh-loading');
    }
    function progressDec() {
        inflight = Math.max(0, inflight - 1);
        if (inflight === 0) document.body.classList.remove('gh-loading');
    }

    async function ajax(action, body={}) {
        progressInc();
        try {
            const fd=new FormData(); fd.append('action',action); fd.append('nonce',NONCE);
            Object.entries(body).forEach(([k,v])=>fd.append(k,v));
            // Non far throw-are il Promise: ogni chiamante si aspetta { success, data }.
            // Se fetch o .json() falliscono (es. server risponde HTML/PHP notice o
            // 500 con body non-JSON), parsiamo il testo e ritorniamo success:false
            // con il body raw in .data. Senza questo, TUTTI i bottoni che fanno
            // `await ajax(...)` muoiono silenziosamente con una unhandled promise
            // rejection — sintomo classico di "ho cliccato e non succede niente".
            let res;
            try { res = await fetch(AJAX, { method:'POST', body: fd, credentials:'same-origin' }); }
            catch (e) {
                console.error('[GH.ajax] network failure', action, e);
                return { success:false, data:'network: ' + (e && e.message || 'fetch failed') };
            }
            const text = await res.text();
            try { return JSON.parse(text); }
            catch (e) {
                console.error('[GH.ajax] non-JSON response', action, 'status=' + res.status, text.slice(0, 500));
                // Strippa eventuale HTML per leggibilita nel toast.
                const plain = text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
                return { success:false, data:'server returned non-JSON (HTTP ' + res.status + '): ' + (plain || '(empty body)') };
            }
        } finally {
            progressDec();
        }
    }
    function toast(msg,type='ok',ms=3000) {
        const t=document.createElement('div'); t.className='toast '+type; t.textContent=msg;
        // Errori persistenti con bottone di dismiss se ms<=0.
        if (ms<=0) {
            t.classList.add('toast-sticky');
            const x=document.createElement('button'); x.className='toast-x'; x.textContent='×';
            x.onclick=()=>t.remove(); t.appendChild(x);
            document.getElementById('gh-toasts').appendChild(t); return t;
        }
        document.getElementById('gh-toasts').appendChild(t); setTimeout(()=>t.remove(),ms);
        return t;
    }
    function esc(s){const d=document.createElement('div');d.textContent=s;return d.innerHTML}

    // ajaxWithToast: wrapper che collassa ~100 pattern "if !r.success toast err".
    // opts: { okMsg?: string, errPrefix?: string, stickyErr?: bool }
    // Ritorna il response originale {success, data}.
    async function ajaxWithToast(action, body={}, opts={}) {
        const { okMsg='', errPrefix='Errore', stickyErr=false } = opts;
        try {
            const r = await ajax(action, body);
            if (!r || !r.success) {
                const msg = errPrefix + (r && r.data ? ': ' + r.data : '');
                toast(msg, 'err', stickyErr ? 0 : 3000);
                return r || { success:false, data:'no response' };
            }
            if (okMsg) toast(okMsg, 'ok');
            return r;
        } catch (e) {
            toast(errPrefix + ': ' + (e.message || 'network'), 'err', stickyErr ? 0 : 3000);
            return { success:false, data:e.message || 'network' };
        }
    }

    // emptyState: genera markup standard per liste vuote. Icona letterale
    // (HTML entity), testo escapato.
    function emptyState(icon, text, extraClass='') {
        const cls = ('empty-state ' + (extraClass||'')).trim();
        return '<div class="'+esc(cls)+'"><div class="empty-icon">'+(icon||'&#9898;')+'</div><div class="empty-text">'+esc(text||'')+'</div></div>';
    }

    // statusChip: <span class="gh-status gh-status--{variant}">{label}</span>
    function statusChip(label, variant='dim') {
        const allowed = ['ok','err','warn','info','dim'];
        const v = allowed.indexOf(variant) >= 0 ? variant : 'dim';
        return '<span class="gh-status gh-status--'+v+'">'+esc(label||'')+'</span>';
    }

    let _wakeLock = null;
    async function acquireWakeLock() {
        try { if ('wakeLock' in navigator) _wakeLock = await navigator.wakeLock.request('screen'); } catch(e) {}
    }
    function releaseWakeLock() {
        if (_wakeLock) { _wakeLock.release().catch(()=>{}); _wakeLock = null; }
    }
    // ── Long-run guard ─────────────────────────────────────────────
    // Operazioni a chunk (export/import roundtrip) durano minuti. Due rischi
    // se l'utente lascia: (1) beforeunload non avvisa, (2) il wake lock viene
    // auto-rilasciato quando la tab passa in background e il loop fetch viene
    // throttlato. beginRun/endRun avvolgono questi flussi: armano un warning
    // di uscita e ri-acquisiscono il wake lock al ritorno sulla tab.
    let _runActive = 0;
    function beginRun() { _runActive++; }
    function endRun()   { _runActive = Math.max(0, _runActive - 1); }
    function isRunActive() { return _runActive > 0; }
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && _runActive > 0 && !_wakeLock) {
            acquireWakeLock();
        }
    });
    window.addEventListener('beforeunload', (e) => {
        if (_runActive > 0) { e.preventDefault(); e.returnValue = ''; return ''; }
    });
    function hl(j){return String(j).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g,m=>{let c='jn';if(/^"/.test(m))c=/:$/.test(m)?'jk':'js';else if(/true|false/.test(m))c='jb';else if(/null/.test(m))c='jx';return'<span class="'+c+'">'+m+'</span>'})}
    function fileSize(b){if(b<1024)return b+' B';if(b<1048576)return(b/1024).toFixed(1)+' KB';return(b/1048576).toFixed(1)+' MB'}
    // ── Dirty tracking (global) ────────────────────────────────────
    // Editor registra markDirty() on change, clearDirty() on save. switchTab
    // chiede conferma prima di cambiare pannello. beforeunload warna per
    // refresh/chiusura scheda.
    let _dirty = false;
    function markDirty(){ _dirty = true; }
    function clearDirty(){ _dirty = false; }
    function isDirty(){ return _dirty; }
    window.addEventListener('beforeunload', (e) => { if (_dirty) { e.preventDefault(); e.returnValue = ''; } });

    // ── Shortcut map (global, per-panel) ───────────────────────────
    // Un editor puo registrare un handler Esc / Save. switchTab azzera.
    let _shortcuts = { close: null, save: null };
    function registerShortcuts(map){ _shortcuts = Object.assign({close:null,save:null}, map||{}); }
    function clearShortcuts(){ _shortcuts = { close:null, save:null }; }

    // Handler globale tastiera: '/', Esc, Cmd/Ctrl+S
    document.addEventListener('keydown', (e) => {
        const tag = e.target && e.target.tagName;
        const inField = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (e.target && e.target.isContentEditable);
        // Cmd/Ctrl+S: save sempre (anche dentro i field)
        if ((e.metaKey || e.ctrlKey) && (e.key === 's' || e.key === 'S')) {
            if (_shortcuts.save) { e.preventDefault(); _shortcuts.save(); }
            return;
        }
        if (inField) return; // '/' e Esc solo fuori dai field
        if (e.key === '/') {
            const panel = document.querySelector('#gh .panel.active');
            if (!panel) return;
            const search = panel.querySelector('input[type="search"], .search-input, input[id*="search"], input[placeholder*="erca"]');
            if (search) { e.preventDefault(); search.focus(); search.select && search.select(); }
        } else if (e.key === 'Escape' && _shortcuts.close) {
            _shortcuts.close();
        }
    });

    // ── Hash routing ───────────────────────────────────────────────
    // Formato: #/<tab-name>  oppure #/<tab-name>/<entity-id>
    // Al load: se c'e un hash, switcha alla tab. Le editor open-by-id sono
    // opzionali: un editor puo registrare un opener con registerDeepOpener.
    const _openers = {};
    function registerDeepOpener(tabName, fn){ _openers[tabName] = fn; }

    function applyHashRoute() {
        const hash = (location.hash || '').replace(/^#\/?/, '');
        if (!hash) return;
        const [tab, ...rest] = hash.split('/');
        if (!tab) return;
        const panel = document.getElementById('panel-'+tab);
        if (!panel) return;
        const btn = document.querySelector('#gh .tab-item[onclick*="\''+tab+'\'"]');
        if (btn) btn.click(); else {
            document.querySelectorAll('#gh .panel').forEach(p => p.classList.remove('active'));
            panel.classList.add('active');
        }
        const entityId = rest.join('/');
        if (entityId && typeof _openers[tab] === 'function') {
            // defer: lascia al tab il tempo di caricare la lista
            setTimeout(() => _openers[tab](entityId), 150);
        }
    }
    window.addEventListener('DOMContentLoaded', applyHashRoute);
    window.addEventListener('hashchange', applyHashRoute);

    function updateHash(tab, entityId){
        const h = '#/' + tab + (entityId ? '/' + entityId : '');
        if (location.hash !== h) history.replaceState(null, '', h);
    }

    // ── Tab-change listeners ───────────────────────────────────────
    // Modules register a callback here to react to a tab opening (lazy
    // load, refresh, ...). They used to do it by wrapping GH.switchTab
    // around the previous definition, which had three problems: the
    // behaviour depended on script load order; any caller holding a
    // reference to an earlier definition silently skipped every later
    // hook; and one throwing hook broke the whole chain for everyone.
    // A flat list has none of those properties.
    const _tabListeners = [];
    function onTabChange(fn){
        if (typeof fn === 'function') _tabListeners.push(fn);
    }

    // Returns true when the tab actually changed, false when the user
    // cancelled at the unsaved-changes prompt. Listeners fire only on a
    // real switch — reloading the target tab's data after the user chose
    // to STAY on the current one was never intended.
    function switchTab(name,el){
        if (_dirty && !confirm('Hai modifiche non salvate. Cambiare tab senza salvare?')) return false;
        _dirty = false;
        clearShortcuts();
        document.querySelectorAll('#gh .tab-item').forEach(t=>{
            t.classList.remove('active');
            t.removeAttribute('aria-current');
        });
        document.querySelectorAll('#gh .panel').forEach(p=>p.classList.remove('active'));
        if (el) { el.classList.add('active'); el.setAttribute('aria-current','page'); }
        const p = document.getElementById('panel-'+name);
        if (p) p.classList.add('active');
        updateHash(name);
        for (const fn of _tabListeners) {
            // One bad listener must not stop the others from running.
            try { fn(name, el); }
            catch (e) { console.error('[GH] tab-change listener failed:', e); }
        }
        return true;
    }

    // ── Copy JSON utility ──────────────────────────────────────────
    function copyToClipboard(text) {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            return navigator.clipboard.writeText(text);
        }
        return new Promise((resolve) => {
            const ta = document.createElement('textarea');
            ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
            document.body.appendChild(ta); ta.select();
            try { document.execCommand('copy'); } catch(e){}
            ta.remove(); resolve();
        });
    }
    function copyJSON(data, label='JSON'){
        const json = JSON.stringify(data, null, 2);
        copyToClipboard(json).then(() => toast(label + ' copiato negli appunti', 'ok'));
    }

    // GH.confirm: replace nativo confirm() con un modal in-panel. Ritorna Promise<bool>.
    // Uso: if (!await GH.confirm('Eliminare?', { danger:true })) return;
    function ghConfirm(msg, opts) {
        opts = opts || {};
        const title       = opts.title       || '';
        const okLabel     = opts.okLabel     || 'OK';
        const cancelLabel = opts.cancelLabel || 'Annulla';
        const danger      = !!opts.danger;

        return new Promise((resolve) => {
            const overlay = document.createElement('div');
            overlay.className = 'gh-modal-overlay';
            const bodyHtml = String(msg || '').replace(/\n/g, '<br>');
            // Unique ids so the dialog can point at its own title/body:
            // without them a screen reader announces "dialog" and nothing else.
            const uid   = 'gh-modal-' + (++_modalSeq);
            const titId = uid + '-title';
            const bodId = uid + '-body';
            overlay.innerHTML =
                '<div class="gh-modal" role="dialog" aria-modal="true"' +
                     (title ? ' aria-labelledby="' + titId + '"' : '') +
                     ' aria-describedby="' + bodId + '">' +
                    (title ? '<div class="gh-modal-title" id="' + titId + '">' + esc(title) + '</div>' : '') +
                    '<div class="gh-modal-body" id="' + bodId + '">' + bodyHtml + '</div>' +
                    '<div class="gh-modal-actions">' +
                        '<button type="button" class="btn btn-ghost gh-modal-cancel">' + esc(cancelLabel) + '</button>' +
                        '<button type="button" class="btn ' + (danger ? 'btn-danger' : 'btn-primary') + ' gh-modal-ok">' + esc(okLabel) + '</button>' +
                    '</div>' +
                '</div>';
            // Attacca dentro #gh per ereditare lo scope CSS.
            (document.getElementById('gh') || document.body).appendChild(overlay);

            // Whatever had focus before the dialog opened gets it back on
            // close — otherwise focus falls to <body> and a keyboard user
            // restarts their Tab journey from the top of the page.
            const returnFocusTo = document.activeElement;

            function cleanup(result) {
                document.removeEventListener('keydown', keyHandler);
                overlay.remove();
                if (returnFocusTo && typeof returnFocusTo.focus === 'function') {
                    returnFocusTo.focus();
                }
                resolve(result);
            }
            function keyHandler(e) {
                if (e.key === 'Escape') { e.preventDefault(); cleanup(false); return; }
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); cleanup(true); return; }
                // Focus trap: aria-modal only tells assistive tech the rest of
                // the page is inert, it does not stop Tab from walking out.
                if (e.key === 'Tab') {
                    const f = overlay.querySelectorAll('button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
                    if (!f.length) return;
                    const first = f[0], last = f[f.length - 1];
                    if (e.shiftKey && document.activeElement === first) {
                        e.preventDefault(); last.focus();
                    } else if (!e.shiftKey && document.activeElement === last) {
                        e.preventDefault(); first.focus();
                    }
                }
            }
            overlay.querySelector('.gh-modal-ok').addEventListener('click', () => cleanup(true));
            overlay.querySelector('.gh-modal-cancel').addEventListener('click', () => cleanup(false));
            overlay.addEventListener('click', (e) => { if (e.target === overlay) cleanup(false); });
            document.addEventListener('keydown', keyHandler);
            // Focus sul bottone primario per abilitare Tab e Enter immediato.
            setTimeout(() => {
                const ok = overlay.querySelector('.gh-modal-ok');
                if (ok) ok.focus();
            }, 10);
        });
    }

    // wireDirtyInputs(containerId): su ogni input/textarea/select dentro il
    // container, aggancia markDirty() su input/change (idempotente, safe da
    // chiamare piu volte sullo stesso container).
    function wireDirtyInputs(containerId){
        const c = document.getElementById(containerId);
        if (!c) return;
        c.querySelectorAll('input, textarea, select').forEach(el => {
            if (el.__ghDirtyBound) return;
            el.__ghDirtyBound = true;
            el.addEventListener('input',  () => markDirty());
            el.addEventListener('change', () => markDirty());
        });
    }
    function getFilters(pfx){const f={};const s=document.getElementById(pfx+'-filter-status');if(s)f.status=s.value;const b=document.getElementById(pfx+'-filter-brand');if(b&&b.value)f.brand=b.value;const c=document.getElementById(pfx+'-filter-stock');if(c&&c.checked)f.in_stock=true;return f}

    // ── TAXONOMY (product_cat | product_brand) ─────────────────
    function taxSource(){const s=document.getElementById('tax-source');return s?s.value:'product_cat'}
    function countNodes(n){let c=n.length;for(const nd of n)c+=countNodes(nd.children||[]);return c}
    async function loadTaxonomy(){const btn=document.getElementById('btn-tax-load'),sp=document.getElementById('tax-spin'),tax=taxSource();btn.disabled=true;sp.style.display='';taxSelected=null;document.getElementById('tax-detail').style.display='none';try{const r=await ajax('rp_cm_ajax_taxonomy_tree',{taxonomy:tax});if(!r.success){toast('Errore','err');return}taxTree=r.data;renderTaxTree();toast(countNodes(taxTree)+' termini in '+tax,'ok')}catch(e){toast('Errore','err')}finally{btn.disabled=false;sp.style.display='none'}}
    function renderTaxTree(){const a=document.getElementById('tax-tree-area');if(!taxTree.length){a.innerHTML='<div class="empty-state"><div class="empty-text">Nessun termine</div></div>';return}a.innerHTML=renderNodes(taxTree,0)}
    function renderNodes(nodes,depth){let h='';for(const nd of nodes){const k=nd.children&&nd.children.length,col=taxCollapsed[nd.id],sel=taxSelected===nd.id?' selected':'',dc=depth<=2?' depth-'+depth:'';h+='<div class="tax-node"><div class="tax-row'+sel+'" onclick="GH.taxSelect('+nd.id+',this)"><span class="tax-toggle" onclick="event.stopPropagation();GH.taxToggle('+nd.id+')">'+(k?(col?'\u25B6':'\u25BC'):'')+'</span><span class="tax-name'+dc+'">'+esc(nd.name)+'</span><span class="tax-count">'+nd.count+'</span><span class="tax-id">#'+nd.id+'</span><span class="tax-actions"><button class="tax-btn" onclick="event.stopPropagation();GH.taxAdd('+nd.id+')">+ figlio</button><button class="tax-btn" onclick="event.stopPropagation();GH.taxRename('+nd.id+')">rinomina</button><button class="tax-btn del" onclick="event.stopPropagation();GH.taxDelete('+nd.id+',\''+esc(nd.name).replace(/'/g,"\\'")+'\')">elimina</button></span></div>';if(k&&!col)h+=renderNodes(nd.children,depth+1);h+='</div>'}return h}
    function taxToggle(id){taxCollapsed[id]=!taxCollapsed[id];renderTaxTree()}
    async function taxSelect(id){taxSelected=id;renderTaxTree();const det=document.getElementById('tax-detail');document.getElementById('tax-detail-title').textContent=findNode(taxTree,id)?.name||'#'+id;document.getElementById('tax-detail-id').textContent='#'+id;const list=document.getElementById('tax-products-list');list.innerHTML='<div style="padding:16px;color:var(--dim);font-family:var(--mono);font-size:11px"><span class="spin"></span></div>';det.style.display='flex';const r=await ajax('rp_cm_ajax_taxonomy_products',{term_id:id,taxonomy:taxSource()});if(!r.success||!r.data.length){list.innerHTML='<div style="padding:16px;color:var(--dim);font-family:var(--mono);font-size:11px">'+(r.success?'Nessun prodotto':'Errore')+'</div>';return}list.innerHTML=r.data.map(p=>'<div class="tax-product-row"><span class="tax-product-id">#'+p.id+'</span><span class="tax-product-name">'+esc(p.name)+'</span><span class="tax-product-type type-'+p.type+'">'+p.type+'</span></div>').join('')}
    function findNode(nodes,id){for(const n of nodes){if(n.id===id)return n;if(n.children){const f=findNode(n.children,id);if(f)return f}}return null}
    async function taxCreateRoot(){const label=taxSource()==='product_brand'?'nuovo brand':'nuova sezione';const n=prompt('Nome '+label+':');if(!n?.trim())return;const r=await ajax('rp_cm_ajax_taxonomy_create',{name:n.trim(),parent_id:0,taxonomy:taxSource()});if(!r.success){toast('Errore: '+r.data,'err');return}toast('Creato "'+n.trim()+'"','ok');loadTaxonomy()}
    async function taxAdd(pid){const nd=findNode(taxTree,pid);const n=prompt('Figlio di "'+(nd?nd.name:'')+'":');if(!n?.trim())return;const r=await ajax('rp_cm_ajax_taxonomy_create',{name:n.trim(),parent_id:pid,taxonomy:taxSource()});if(!r.success){toast('Errore: '+r.data,'err');return}taxCollapsed[pid]=false;toast('Creato','ok');loadTaxonomy()}
    async function taxRename(id){const nd=findNode(taxTree,id);const n=prompt('Nuovo nome:',nd?nd.name:'');if(!n?.trim())return;const r=await ajax('rp_cm_ajax_taxonomy_rename',{term_id:id,name:n.trim(),taxonomy:taxSource()});if(!r.success){toast('Errore: '+r.data,'err');return}toast('Rinominato','ok');loadTaxonomy()}
    async function taxDelete(id,name){if(!confirm('Eliminare "'+name+'"?'))return;const r=await ajax('rp_cm_ajax_taxonomy_delete',{term_id:id,taxonomy:taxSource()});if(!r.success){toast('Errore: '+r.data,'err');return}if(taxSelected===id){taxSelected=null;document.getElementById('tax-detail').style.display='none'}toast('Eliminato','ok');loadTaxonomy()}

    // ── WHITELIST
    let wlCache = []; // cached list for copy/export

    async function loadWhitelist(){
        const r=await ajax('rp_mm_ajax_get_whitelist');
        if(!r.success){toast('Errore','err');return}
        wlCache=r.data||[];
        const a=document.getElementById('wl-area');
        if(!wlCache.length){a.innerHTML='<div class="empty-state"><div class="empty-icon">&#9737;</div><div class="empty-text">Whitelist vuota. Aggiungi URL dalla toolbar o incolla in bulk.</div></div>';return}
        a.innerHTML='<div style="padding:0 4px 8px;font-family:var(--mono);font-size:10px;color:var(--dim)">'+wlCache.length+' elementi protetti</div>'+wlCache.map(e=>{
            const u=e.url||'';const short=u.replace(/^https?:\/\/[^/]+/,'');
            return'<div class="wl-row"><img class="wl-thumb" src="'+esc(u)+'" onerror="this.style.visibility=\'hidden\'" /><div class="wl-info"><div class="wl-reason mono" style="font-size:10px;color:var(--acc);word-break:break-all" title="'+esc(u)+'">'+esc(short||'#'+(e.id||'?'))+'</div>'+(e.reason?'<div class="wl-name" style="font-size:10px;color:var(--dim)">'+esc(e.reason)+'</div>':'')+'</div><span class="wl-id">#'+(e.id||'?')+'</span><button class="btn btn-ghost" style="font-size:10px" onclick="GH.removeWL('+(e.id||0)+')">Rimuovi</button></div>'
        }).join('');
    }

    // Single add: ID or URL, reason optional
    async function whitelistAdd(){
        const id=parseInt(document.getElementById('wl-add-id').value||'0');
        const url=(document.getElementById('wl-add-url').value||'').trim();
        const reason=(document.getElementById('wl-add-reason').value||'').trim();
        if(!id&&!url){toast('Serve un ID o URL','err');return}
        const sp=document.getElementById('wl-add-spin');
        if(sp)sp.style.display='';
        try{
            const body={};
            if(id)body.attachment_id=id;
            if(url)body.url=url;
            if(reason)body.reason=reason;
            const r=await ajax('rp_mm_ajax_add_whitelist',body);
            if(!r.success){toast(r.data||'Errore','err');return}
            document.getElementById('wl-add-id').value='';
            document.getElementById('wl-add-url').value='';
            document.getElementById('wl-add-reason').value='';
            toast('Aggiunto','ok');loadWhitelist();
        }catch(e){toast('Errore','err')}
        finally{if(sp)sp.style.display='none'}
    }

    // Copy all whitelisted URLs to clipboard
    function wlCopyAll(){
        if(!wlCache.length){toast('Whitelist vuota','inf');return}
        const text=wlCache.map(e=>e.url||'').filter(Boolean).join('\n');
        navigator.clipboard.writeText(text).then(()=>toast(wlCache.length+' URL copiati','ok'),()=>toast('Errore clipboard','err'));
    }

    // Toggle bulk textarea
    function wlToggleBulk(){
        const area=document.getElementById('wl-bulk-area');
        area.style.display=area.style.display==='none'?'':'none';
    }

    // Export current whitelist into the textarea
    function wlBulkExport(){
        const text=wlCache.map(e=>e.url||'').filter(Boolean).join('\n');
        document.getElementById('wl-bulk-text').value=text;
        document.getElementById('wl-bulk-status').textContent=wlCache.length+' URL esportati';
    }

    // Import URLs from textarea (one per line)
    async function wlBulkImport(){
        const raw=document.getElementById('wl-bulk-text').value;
        const urls=raw.split('\n').map(s=>s.trim()).filter(s=>s&&(s.startsWith('http')||s.startsWith('/')));
        if(!urls.length){toast('Nessun URL valido trovato','err');return}
        const sp=document.getElementById('wl-bulk-spin');
        const statusEl=document.getElementById('wl-bulk-status');
        if(sp)sp.style.display='';
        let added=0,skipped=0;
        try{
            // Send in batches of 20
            for(let i=0;i<urls.length;i+=20){
                const batch=urls.slice(i,i+20);
                for(const url of batch){
                    // Check if already in cache
                    if(wlCache.some(e=>e.url===url)){skipped++;continue}
                    await ajax('rp_mm_ajax_add_whitelist',{url:url,reason:'bulk import'});
                    added++;
                }
                if(statusEl)statusEl.textContent='Importazione '+(i+batch.length)+'/'+urls.length+'...';
            }
            toast(added+' aggiunti'+(skipped?' ('+skipped+' duplicati)':''),'ok');
            document.getElementById('wl-bulk-text').value='';
            if(statusEl)statusEl.textContent=added+' importati';
            loadWhitelist();
        }catch(e){toast('Errore: '+e.message,'err')}
        finally{if(sp)sp.style.display='none'}
    }

    async function addWL(id,reason){await ajax('rp_mm_ajax_add_whitelist',{attachment_id:id,reason:reason||''});toast('#'+id+' protetto','ok');loadWhitelist()}
    async function removeWL(id){await ajax('rp_mm_ajax_remove_whitelist',{attachment_id:id});toast('#'+id+' rimosso','ok');loadWhitelist()}

    // ── GS FEED
    function gsPriceModeChange() {
        const mode = document.getElementById('gs-price-mode').value;
        document.getElementById('gs-sale-multiplier').style.display = mode === 'sale' ? '' : 'none';
    }
    function gsGetPriceOpts() {
        const mode = document.getElementById('gs-price-mode')?.value || 'direct';
        const mult = parseFloat(document.getElementById('gs-sale-multiplier')?.value) || 1.3;
        return { price_mode: mode, sale_mult: mult };
    }
    async function gsFetch(){const ov=document.getElementById('gs-overlay'),ot=document.getElementById('gs-overlay-text'),btn=document.getElementById('btn-gs-fetch'),sp=document.getElementById('gs-fetch-spin');ot.textContent='Fetch feed...';ov.classList.add('visible');btn.disabled=true;sp.style.display='';try{const cfg={url:document.getElementById('gs-url').value,token:document.getElementById('gs-token').value,cookie:document.getElementById('gs-cookie').value,format:document.getElementById('gs-format').value};const r=await ajax('rp_rc_ajax_gs_fetch',{config:JSON.stringify(cfg)});if(!r.success){toast('Errore: '+r.data,'err');return}gsProducts=r.data.products;toast(r.data.product_count+' prodotti','ok');ot.textContent='Confronto WooCommerce...';const po=gsGetPriceOpts();const dr=await ajax('rp_rc_ajax_gs_preview',{products:JSON.stringify(gsProducts),price_mode:po.price_mode,sale_mult:po.sale_mult});if(!dr.success){toast('Errore diff','err');return}renderGsPreview(dr.data)}catch(e){toast('Errore','err')}finally{ov.classList.remove('visible');btn.disabled=false;sp.style.display='none'}}
    function renderGsPreview(d){const s=d.summary;gsDiffData=d;document.getElementById('gs-stats').style.display='flex';document.getElementById('gs-total').textContent=s.total;document.getElementById('gs-new').textContent=s.new;document.getElementById('gs-update').textContent=s.update;document.getElementById('gs-unchanged').textContent=s.unchanged;const all=[...d.new.map(p=>({...p,_a:'new'})),...d.update.map(p=>({...p,_a:'update'})),...d.unchanged.map(p=>({...p,_a:'unchanged'}))];gsSelected=new Set(all.filter(p=>p._a!=='unchanged').map(p=>p.sku));let h='<table class="ptable"><thead><tr><th style="width:28px"><input type="checkbox" class="gs-check" id="gs-check-all" onchange="GH.gsToggleAll(this.checked)" /></th><th>Azione</th><th>SKU</th><th>Nome</th><th>Brand</th><th>Modello</th><th>Taglie</th><th>Disp.</th><th style="width:60px" title="Hand-off al tab KicksDB Refresh Pricing per la SKU di questa riga">KDB</th></tr></thead><tbody>';for(const p of all){const cls=p._a==='new'?'st-new':p._a==='update'?'st-update':'st-unchanged';const lb=p._a==='new'?'+ Nuovo':p._a==='update'?'\u21bb Agg.':'\u2713';const sz=p.sizes?p.sizes.length:(p.variations?p.variations.length:0);const ck=gsSelected.has(p.sku)?'checked':'';const skuJs=(p.sku||'').replace(/'/g,"\\'");h+='<tr><td><input type="checkbox" class="gs-check" data-sku="'+esc(p.sku)+'" data-type="'+p._a+'" '+ck+' onchange="GH.gsToggle(this)" /></td><td class="'+cls+'">'+lb+'</td><td>'+esc(p.sku||'')+'</td><td>'+esc(p.name||'')+'</td><td>'+esc(p.brand||p._gs_brand||'')+'</td><td>'+esc(p.model||p._gs_model||'')+'</td><td>'+sz+'</td><td>'+(p.total_available??'?')+'</td><td><button class="btn btn-ghost" style="font-size:9px;padding:2px 6px" title="Refresh prezzo KicksDB (rispetta conflict rules e tracked flag)" onclick="GH.kdbRefreshSelected([\''+skuJs+'\'])">\u21bb KDB</button></td></tr>'}h+='</tbody></table>';document.getElementById('gs-preview').innerHTML=h;document.getElementById('gs-sel-bar').style.display='flex';gsUpdateSelCount();gsUpdateConfirm()}
    function gsToggle(cb){if(cb.checked)gsSelected.add(cb.dataset.sku);else gsSelected.delete(cb.dataset.sku);document.getElementById('gs-check-all').checked=gsSelected.size===document.querySelectorAll('#gs-preview .gs-check[data-sku]').length;gsUpdateSelCount();gsUpdateConfirm()}
    function gsToggleAll(on){document.querySelectorAll('#gs-preview .gs-check[data-sku]').forEach(c=>{c.checked=on;if(on)gsSelected.add(c.dataset.sku);else gsSelected.delete(c.dataset.sku)});gsUpdateSelCount();gsUpdateConfirm()}
    function gsSelectAll(){document.querySelectorAll('#gs-preview .gs-check[data-sku]').forEach(c=>{c.checked=true;gsSelected.add(c.dataset.sku)});document.getElementById('gs-check-all').checked=true;gsUpdateSelCount();gsUpdateConfirm()}
    function gsSelectNone(){document.querySelectorAll('#gs-preview .gs-check[data-sku]').forEach(c=>{c.checked=false});gsSelected.clear();document.getElementById('gs-check-all').checked=false;gsUpdateSelCount();gsUpdateConfirm()}
    function gsSelectByType(type){document.querySelectorAll('#gs-preview .gs-check[data-sku]').forEach(c=>{const on=c.dataset.type===type;c.checked=on;if(on)gsSelected.add(c.dataset.sku);else gsSelected.delete(c.dataset.sku)});document.getElementById('gs-check-all').checked=false;gsUpdateSelCount();gsUpdateConfirm()}
    function gsUpdateSelCount(){const n=gsSelected.size;document.getElementById('gs-sel-count').textContent=n+' selezionat'+(n===1?'o':'i')}
    function gsUpdateConfirm(){const bar=document.getElementById('gs-confirm');if(!gsSelected.size){bar.style.display='none';return}let nn=0,nu=0;gsSelected.forEach(sku=>{if(gsDiffData.new.some(p=>p.sku===sku))nn++;else if(gsDiffData.update.some(p=>p.sku===sku))nu++});let msg='';if(nn)msg+='<span>'+nn+'</span> nuov'+(nn===1?'o':'i');if(nn&&nu)msg+=', ';if(nu)msg+='<span>'+nu+'</span> da aggiornare';if(!nn&&!nu){bar.style.display='none';return}document.getElementById('gs-confirm-text').innerHTML=msg;bar.style.display='flex'}
    async function gsApply(){if(!gsProducts||!gsSelected.size)return;const sel=gsProducts.filter(p=>gsSelected.has(p.sku));const ov=document.getElementById('gs-overlay'),ot=document.getElementById('gs-overlay-text'),btn=document.getElementById('btn-gs-apply'),sp=document.getElementById('gs-apply-spin');ot.textContent='Importazione '+sel.length+' prodott'+(sel.length===1?'o':'i')+'...';ov.classList.add('visible');btn.disabled=true;sp.style.display='';await acquireWakeLock();try{const asDraft=document.getElementById('gs-opt-draft')?.checked||false;const force=document.getElementById('gs-opt-force')?.checked||false;const gpo=gsGetPriceOpts();const r=await ajax('rp_rc_ajax_gs_apply',{products:JSON.stringify(sel),options:JSON.stringify({create_new:true,update_existing:true,sideload_images:document.getElementById('gs-opt-images').checked,force_recreate:force,status:asDraft?'draft':'publish',price_mode:gpo.price_mode,sale_mult:gpo.sale_mult})});if(!r.success){toast('Errore','err');return}const s=r.data.summary;let h='<table class="ptable"><thead><tr><th>Risultato</th><th>ID</th><th>SKU</th><th>Nome</th></tr></thead><tbody>';for(const d of r.data.details){const c=d.action==='created'?'st-created':(d.action==='updated'||d.action==='recreated')?'st-updated':'st-error';const l=d.action==='created'?'+ Creato':d.action==='updated'?'\u2713 Agg.':d.action==='recreated'?'\u267b Ricreato':'\u2717 Err';h+='<tr><td class="'+c+'">'+l+'</td><td>'+(d.id||'\u2013')+'</td><td>'+esc(d.sku||'')+'</td><td>'+esc(d.name||'')+'</td></tr>'}h+='</tbody></table>';document.getElementById('gs-preview').innerHTML=h;document.getElementById('gs-confirm').style.display='none';document.getElementById('gs-sel-bar').style.display='none';toast(s.created+' creati, '+s.updated+' aggiornati'+(s.recreated?', '+s.recreated+' ricreati':''),'ok',5000)}catch(e){toast('Errore','err')}finally{releaseWakeLock();ov.classList.remove('visible');btn.disabled=false;sp.style.display='none'}}
    async function gsQuickPatch(){if(!gsProducts||!gsSelected.size)return;const sel=gsProducts.filter(p=>gsSelected.has(p.sku));const ov=document.getElementById('gs-overlay'),ot=document.getElementById('gs-overlay-text'),btn=document.getElementById('btn-gs-quickpatch'),sp=document.getElementById('gs-quickpatch-spin');ot.textContent='Quick patch '+sel.length+' prodott'+(sel.length===1?'o':'i')+'...';ov.classList.add('visible');btn.disabled=true;sp.style.display='';try{const gpo2=gsGetPriceOpts();const r=await ajax('rp_rc_ajax_gs_quick_patch',{products:JSON.stringify(sel),price_mode:gpo2.price_mode,sale_mult:gpo2.sale_mult});if(!r.success){toast('Errore','err');return}const s=r.data.summary;let h='<table class="ptable"><thead><tr><th>Risultato</th><th>ID</th><th>SKU</th><th>Nome</th></tr></thead><tbody>';for(const d of r.data.details){const c=d.action==='patched'?'st-updated':'st-error';h+='<tr><td class="'+c+'">'+(d.action==='patched'?'\u2713 Patch':'\u2717 Err')+'</td><td>'+(d.id||'\u2013')+'</td><td>'+esc(d.sku||'')+'</td><td>'+esc(d.name||'')+'</td></tr>'}h+='</tbody></table>';document.getElementById('gs-preview').innerHTML=h;document.getElementById('gs-confirm').style.display='none';toast(s.patched+' aggiornati, '+s.skipped+' invariati','ok',5000)}catch(e){toast('Errore','err')}finally{ov.classList.remove('visible');btn.disabled=false;sp.style.display='none'}}
    function gsCancel(){document.getElementById('gs-confirm').style.display='none';document.getElementById('gs-sel-bar').style.display='none'}
    async function gsLabelPreview(){const raw=document.getElementById('gs-label-skus').value;if(!raw.trim()){toast('Incolla almeno uno SKU','err');return}const btn=document.getElementById('btn-gs-label-preview'),sp=document.getElementById('gs-label-preview-spin'),st=document.getElementById('gs-label-status');btn.disabled=true;sp.style.display='';st.textContent='Verifica...';try{const r=await ajax('gh_ajax_gs_label_preview',{skus:raw});if(!r.success){st.textContent='Errore: '+r.data;return}const d=r.data;let h='<div><b>'+d.matched+'</b> / '+d.total+' SKU corrispondono a prodotti Woo · '+d.not_found+' non trovati</div>';if(d.sample&&d.sample.length){h+='<div style="margin-top:6px;max-height:160px;overflow:auto;font-family:var(--mono);font-size:10px">'+d.sample.map(p=>'#'+p.id+' '+esc(p.sku)+' — '+esc(p.name)).join('<br>')+(d.matched>d.sample.length?'<br>…':'')+'</div>'}st.innerHTML=h}catch(e){st.textContent='Errore'}finally{btn.disabled=false;sp.style.display='none'}}
    async function gsLabelApply(){const raw=document.getElementById('gs-label-skus').value;if(!raw.trim()){toast('Incolla almeno uno SKU','err');return}if(!await ghConfirm('Marcare i prodotti corrispondenti come Golden Sneakers (provenienza + tag «super-sale»)? Nome, prezzo, stock e media NON verranno modificati.',{title:'Etichetta prodotti GS',okLabel:'Etichetta'}))return;const btn=document.getElementById('btn-gs-label-apply'),sp=document.getElementById('gs-label-apply-spin'),st=document.getElementById('gs-label-status');btn.disabled=true;sp.style.display='';st.textContent='Etichettatura...';try{const r=await ajax('gh_ajax_gs_label_apply',{skus:raw});if(!r.success){st.textContent='Errore: '+r.data;toast('Errore','err');return}const d=r.data;st.innerHTML='<div>Etichettati <b>'+d.labeled+'</b> prodotti (tag: '+d.tagged+', già GS: '+d.already+') · '+d.not_found+' SKU non trovati</div>';toast(d.labeled+' prodotti etichettati GS','ok',5000)}catch(e){st.textContent='Errore';toast('Errore','err')}finally{btn.disabled=false;sp.style.display='none'}}

    // ── BULK IMPORT
    function initBulkImport(){const drop=document.getElementById('imp-drop'),inp=document.getElementById('imp-file-input');inp.addEventListener('change',()=>{if(inp.files.length)handleBulkFile(inp.files[0])});drop.addEventListener('dragover',e=>{e.preventDefault();drop.classList.add('dragover')});drop.addEventListener('dragleave',()=>drop.classList.remove('dragover'));drop.addEventListener('drop',e=>{e.preventDefault();drop.classList.remove('dragover');if(e.dataTransfer.files.length)handleBulkFile(e.dataTransfer.files[0])})}
    function handleBulkFile(f){if(!f.name.endsWith('.json')){toast('Solo .json','err');return}const r=new FileReader();r.onload=()=>{try{let d=JSON.parse(r.result);if(Array.isArray(d))d={products:d};if(!d.products?.length){toast('Nessun prodotto','err');return}state.bulkJSON=d;document.getElementById('imp-file-name').textContent=f.name+' \u00b7 '+d.products.length+' prodotti';document.getElementById('imp-mode-row').style.display='flex';document.getElementById('imp-preview-area').innerHTML='';document.getElementById('imp-confirm-bar').style.display='none';toast(d.products.length+' prodotti','inf')}catch(e){toast('JSON non valido','err')}};r.readAsText(f)}
    // Bulk JSON import chunked. Stessa ragione del roundtrip (un payload grande
    // supera il cap ~100s di Cloudflare → 524), MA qui i batch sono dimensionati
    // a "peso" non a numero fisso: un prodotto variabile con 13 varianti = ~14
    // scritture WC (parent + varianti + sync), quindi 50 prodotti possono valere
    // centinaia di save e sforare 100s lo stesso. Accumuliamo prodotti finche il
    // peso (1 + n_varianti) resta sotto il budget, cosi ogni request ha un numero
    // di scritture WC limitato a prescindere dalla distribuzione delle varianti.
    // Le immagini pesano GH_IMG_IMPORT_WEIGHT (4) ciascuna: un download con
    // miniature costa 1-3s. Stessa formula di gh_cm_bulk_entry_weight (PHP).
    const BULK_WEIGHT_BUDGET = 80;
    const BULK_IMG_WEIGHT = 4;
    function bulkImgCount(e, variation){
        if(!e||typeof e!=='object')return 0;
        const one=v=>(v===null||v===''||(Array.isArray(v)&&!v.length))?0:1;
        const many=v=>Array.isArray(v)?v.length:(v&&typeof v==='object'?1:0);
        if(variation){ if('image' in e)return one(e.image); if('images' in e)return Math.min(1,many(e.images)); return 0; }
        if('images' in e)return many(e.images);
        if('featured_image_url' in e||'gallery_image_urls' in e)return (e.featured_image_url?1:0)+(Array.isArray(e.gallery_image_urls)?e.gallery_image_urls.length:0);
        if('image' in e)return one(e.image);
        return 0;
    }
    function bulkWeight(p){
        const vars=(p&&Array.isArray(p.variations))?p.variations:[];
        let imgs=bulkImgCount(p,false);
        for(const v of vars)imgs+=bulkImgCount(v,true);
        return 1 + vars.length + imgs*BULK_IMG_WEIGHT;
    }
    // Cella "Immagini" del preview: piano senza effetti (riuso / download / invalide).
    function bulkImgPlanCell(im){
        if(!im||im.untouched)return '<span style="color:var(--dim)" title="Nessuna chiave immagine nel JSON: immagini attuali invariate">\u2013</span>';
        if(im.clear&&!im.declared)return '<span style="color:var(--amb)" title="images: [] \u2192 featured e gallery verranno rimosse">rimuovi</span>';
        const parts=[];
        if(im.existing||im.local_file)parts.push('<span style="color:var(--grn)" title="Gi\u00e0 nella media library: verranno collegate senza scaricarle">\u267b '+((im.existing||0)+(im.local_file||0))+'</span>');
        if(im.download)parts.push('<span style="color:var(--acc)" title="Verranno scaricate (sideload)">\u2193 '+im.download+'</span>');
        if(im.invalid){const t=(im.invalid_details||[]).map(x=>x.src+' \u2014 '+x.reason).join('\n');parts.push('<span style="color:var(--red)" title="'+esc(t)+'">\u2717 '+im.invalid+'</span>');}
        return parts.join(' ')||'\u2013';
    }
    // Cella "Immagini" del risultato.
    function bulkImgResultCell(im){
        if(!im||!im.touched)return '<span style="color:var(--dim)">\u2013</span>';
        if(im.cleared)return '<span style="color:var(--amb)">rimosse</span>';
        const parts=[];
        if(im.reused||im.registered)parts.push('<span style="color:var(--grn)" title="Collegate dalla media library">\u267b '+((im.reused||0)+(im.registered||0))+'</span>');
        if(im.downloaded)parts.push('<span style="color:var(--acc)" title="Scaricate">\u2193 '+im.downloaded+'</span>');
        const f=(im.failed||[]).length;
        if(f){const t=im.failed.map(x=>x.src+' \u2014 '+x.reason).join('\n');parts.push('<span style="color:var(--red)" title="'+esc(t)+'">\u2717 '+f+'</span>');}
        return parts.join(' ')||'\u2013';
    }
    // Elenco esplicito delle immagini non collegate (i tooltip da soli si perdono).
    function bulkImgFailures(details, key){
        const rows=[];
        for(const d of details){const list=key==='plan'?((d.images&&d.images.invalid_details)||[]):((d.images&&d.images.failed)||[]);for(const x of list)rows.push('<li><b>'+esc(d.sku||d.name||'')+'</b> \u2014 <span style="font-family:var(--mono)">'+esc(x.src||'')+'</span>: '+esc(x.reason||'')+'</li>');}
        if(!rows.length)return '';
        const title=key==='plan'?'Immagini non valide (verranno saltate)':'Immagini non collegate';
        return '<div style="margin-top:10px;padding:8px 12px;border:1px solid var(--red-30);background:var(--red-10);border-radius:4px;font-size:11px"><div style="font-weight:600;color:var(--red);margin-bottom:4px">'+title+' ('+rows.length+')</div><ul style="margin:0;padding-left:18px">'+rows.join('')+'</ul></div>';
    }
    async function bulkRunChunked(action, mode, onProgress){
        const all=state.bulkJSON.products||[];
        const total=all.length;
        const merged={summary:{},details:[]};
        let i=0,done=0,batchNo=0;
        while(i<total){
            // Slice fino al budget di peso (sempre almeno 1 prodotto, anche se
            // da solo pesa piu del budget).
            let w=0,j=i;
            while(j<total && (j===i || w+bulkWeight(all[j])<=BULK_WEIGHT_BUDGET)){ w+=bulkWeight(all[j]); j++; }
            const slice=all.slice(i,j);
            batchNo++;
            let r=null;
            for(let attempt=0;attempt<3;attempt++){
                r=await ajax(action,{json_payload:JSON.stringify({products:slice}),mode});
                if(r.success)break;
                if(attempt<2){await new Promise(res=>setTimeout(res,1000*(attempt+1)));}
            }
            if(!r.success){const d=(typeof r.data==='string'&&r.data)?r.data:'errore sconosciuto';throw new Error('batch '+batchNo+' (prodotti '+(i+1)+'-'+j+'): '+d);}
            const s=r.data.summary||{};
            for(const k in s){if(typeof s[k]==='number')merged.summary[k]=(merged.summary[k]||0)+s[k];}
            if(Array.isArray(r.data.details))merged.details.push(...r.data.details);
            done+=slice.length;i=j;
            if(onProgress)onProgress(done,total);
        }
        return merged;
    }
    async function bulkPreview(){
        if(!state.bulkJSON)return;
        const ov=document.getElementById('imp-overlay'),ot=document.getElementById('imp-overlay-text'),btn=document.getElementById('btn-imp-preview'),sp=document.getElementById('imp-preview-spin');
        ot.textContent='Anteprima...';ov.classList.add('visible');btn.disabled=true;sp.style.display='';
        beginRun(); await acquireWakeLock();
        try{
            const m=document.querySelector('input[name="bulk-mode"]:checked').value;
            const data=await bulkRunChunked('rp_cm_ajax_bulk_preview',m,(done,total)=>{ot.textContent='Anteprima '+done+' / '+total+'...';});
            const s=data.summary,a=document.getElementById('imp-preview-area');
            let h='<table class="ptable"><thead><tr><th>Azione</th><th>Nome</th><th>SKU</th><th>Tipo</th><th>Varianti</th><th>Immagini</th></tr></thead><tbody>';
            for(const d of data.details){const ic=d.action==='create'?'st-create':'st-matched';const hc=d.hide_count?' <span style="color:var(--amb)" title="taglie da nascondere">\u2212'+d.hide_count+'</span>':'';h+='<tr><td class="'+ic+'">'+(d.action==='create'?'+ Nuovo':'\u21bb #'+d.existing_id)+'</td><td>'+esc(d.name)+'</td><td>'+esc(d.sku||'\u2013')+'</td><td>'+d.type+'</td><td>'+(d.variation_count||'\u2013')+hc+'</td><td>'+bulkImgPlanCell(d.images)+'</td></tr>'}
            h+='</tbody></table>'+bulkImgFailures(data.details,'plan');a.innerHTML=h;
            const imgTxt=(s.img_existing||s.img_download)?' \u00b7 immagini: <span>'+(s.img_existing||0)+'</span> dalla libreria, <span>'+(s.img_download||0)+'</span> da scaricare':'';
            const imgBad=s.img_invalid?', <span style="color:var(--red)">'+s.img_invalid+'</span> non valide':'';
            document.getElementById('imp-confirm-text').innerHTML='<span>'+(s.to_create||0)+'</span> da creare'+(s.to_update?', <span>'+s.to_update+'</span> da aggiornare':'')+(s.to_hide?', <span>'+s.to_hide+'</span> da nascondere':'')+imgTxt+imgBad;
            document.getElementById('imp-confirm-bar').style.display='flex'
        }catch(e){toast('Errore anteprima: '+(e.message||e),'err',0)}
        finally{endRun();releaseWakeLock();ov.classList.remove('visible');btn.disabled=false;sp.style.display='none'}
    }
    async function bulkApply(){
        if(!state.bulkJSON)return;
        const ov=document.getElementById('imp-overlay'),ot=document.getElementById('imp-overlay-text'),btn=document.getElementById('btn-imp-apply'),sp=document.getElementById('imp-apply-spin');
        ot.textContent='Creazione prodotti...';ov.classList.add('visible');btn.disabled=true;sp.style.display='';
        beginRun(); await acquireWakeLock();
        try{
            const m=document.querySelector('input[name="bulk-mode"]:checked').value;
            const data=await bulkRunChunked('rp_cm_ajax_bulk_apply',m,(done,total)=>{ot.textContent='Creazione '+done+' / '+total+'...';});
            const s=data.summary,a=document.getElementById('imp-preview-area');
            let h='<table class="ptable"><thead><tr><th>Risultato</th><th>ID</th><th>Nome</th><th>SKU</th><th>Varianti</th><th>Immagini</th></tr></thead><tbody>';
            for(const d of data.details){const c=d.status==='created'?'st-created':d.status==='updated'?'st-updated':'st-error';const hc=d.hidden?' <span style="color:var(--amb)" title="taglie nascoste">\u2212'+d.hidden+'</span>':'';const rs=d.status==='error'&&d.reason?' <span style="color:var(--dim)">'+esc(d.reason)+'</span>':'';h+='<tr><td class="'+c+'">'+(d.status==='created'?'+ Creato':d.status==='updated'?'\u2713 Agg.':'\u2717 Err')+rs+'</td><td>'+(d.id||'\u2013')+'</td><td>'+esc(d.name||'')+'</td><td>'+esc(d.sku||'')+'</td><td>'+(d.variation_count||'\u2013')+hc+'</td><td>'+bulkImgResultCell(d.images)+'</td></tr>'}
            h+='</tbody></table>'+bulkImgFailures(data.details,'result');a.innerHTML=h;document.getElementById('imp-confirm-bar').style.display='none';
            const imgMsg=(s.img_reused||s.img_downloaded||s.img_failed)?' \u00b7 immagini: '+((s.img_reused||0)+(s.img_downloaded||0))+' collegate'+(s.img_failed?', '+s.img_failed+' fallite':''):'';
            toast((s.created||0)+' creati, '+(s.updated||0)+' aggiornati'+((s.hidden)?', '+s.hidden+' nascoste':'')+', '+(s.errors||0)+' errori'+imgMsg,(s.errors||s.img_failed)?'err':'ok',s.img_failed?0:5000)
        }catch(e){toast('Errore import: '+(e.message||e),'err',0)}
        finally{endRun();releaseWakeLock();ov.classList.remove('visible');btn.disabled=false;sp.style.display='none'}
    }
    // Background: carica il file, lancia un job lato server (immune a Cloudflare)
    // e polla lo stato. NON serve tenere la tab aperta: il job prosegue da solo.
    // Niente run-guard qui — chiudere la pagina e sicuro.
    async function bulkApplyBackground(){
        if(!state.bulkJSON)return;
        const ov=document.getElementById('imp-overlay'),ot=document.getElementById('imp-overlay-text');
        ot.textContent='Avvio in background...';ov.classList.add('visible');
        try{
            const m=document.querySelector('input[name="bulk-mode"]:checked').value;
            const r=await ajax('rp_cm_ajax_bulk_dispatch',{json_payload:JSON.stringify(state.bulkJSON),mode:m});
            if(!r.success){toast('Errore avvio: '+(typeof r.data==='string'?r.data:'sconosciuto'),'err',0);ov.classList.remove('visible');return}
            const jobId=r.data.job_id,total=r.data.total;
            document.getElementById('imp-confirm-bar').style.display='none';
            toast('Import avviato in background ('+total+' prodotti). Puoi chiudere la pagina.','ok',6000);
            // Poll fino a done/error. Tollerante a status non disponibili.
            let misses=0;
            while(true){
                await new Promise(res=>setTimeout(res,2500));
                const st=await ajax('rp_cm_ajax_bulk_job_status',{job_id:jobId});
                if(!st.success){ if(++misses>5){ot.textContent='Stato non disponibile — controlla il tab Jobs';break;} continue; }
                misses=0;
                const s=st.data.summary||{};
                const bgImg=(s.img_reused||s.img_downloaded||s.img_failed)?'  ·  img: '+((s.img_reused||0)+(s.img_downloaded||0))+' ok'+(s.img_failed?', '+s.img_failed+' fallite':''):'';
                ot.textContent='Background: '+(s.processed||0)+' / '+(s.total||total)+'  ·  '+(s.created||0)+' creati, '+(s.updated||0)+' agg.'+((s.hidden)?', '+s.hidden+' nasc.':'')+', '+(s.errors||0)+' err.'+bgImg;
                if(st.data.done){
                    if(st.data.status==='error'){toast('Import in background fallito — vedi tab Jobs','err',0);}
                    else{const fi=s.img_failed?', '+s.img_failed+' immagini fallite':'';if(Array.isArray(s.img_failures)&&s.img_failures.length){document.getElementById('imp-preview-area').innerHTML=bulkImgFailures(s.img_failures.map(f=>({sku:f.sku,images:{failed:[f]}})),'result');}toast('Import completato: '+(s.created||0)+' creati, '+(s.updated||0)+' aggiornati'+((s.hidden)?', '+s.hidden+' nascoste':'')+', '+(s.errors||0)+' errori'+fi,(s.errors||s.img_failed)?'err':'ok',s.img_failed?0:6000);}
                    break;
                }
            }
        }catch(e){toast('Errore: '+(e.message||e),'err',0)}
        finally{ov.classList.remove('visible')}
    }
    function bulkCancel(){document.getElementById('imp-confirm-bar').style.display='none';document.getElementById('imp-preview-area').innerHTML=''}

    // ── ROUNDTRIP EXPORT
    // Chunked: prima la lista ID (leggera), poi i prodotti a batch via
    // include_ids con merge client-side. Un singolo export di 600+ prodotti
    // (varianti + immagini + meta + 4 query tassonomia ciascuno) supera il cap
    // ~100s di Cloudflare -> 524 e muore. Stesso pattern dell'import: ogni
    // request e breve. Progress reale + wake lock + retry per-chunk.
    const RT_EXPORT_BATCH = 50;
    // Pure: scarica i prodotti dati (per ID) a chunk e ritorna l'envelope merge.
    // Riusato da generateRoundtrip (tab Roundtrip) e da exportSelectionAsFile
    // (bottone "Export JSON" in Filtra & Agisci).
    async function exportRoundtripChunked(ids, onProgress){
        const total=(ids||[]).length;
        let header=null;const products=[];
        for(let i=0;i<total;i+=RT_EXPORT_BATCH){
            const slice=ids.slice(i,i+RT_EXPORT_BATCH);
            let r=null;
            for(let attempt=0;attempt<3;attempt++){
                r=await ajax('rp_cm_ajax_export_roundtrip',{include_ids:JSON.stringify(slice)});
                if(r.success)break;
                if(attempt<2){await new Promise(res=>setTimeout(res,1000*(attempt+1)));}
            }
            if(!r||!r.success){
                const detail=(r&&typeof r.data==='string'&&r.data)?r.data:'errore sconosciuto';
                throw new Error('batch prodotti '+(i+1)+'-'+Math.min(i+RT_EXPORT_BATCH,total)+': '+detail);
            }
            if(!header)header=r.data;
            if(Array.isArray(r.data.products))products.push(...r.data.products);
            if(onProgress)onProgress(Math.min(i+RT_EXPORT_BATCH,total),total);
        }
        return {
            format:(header&&header.format)||'rp_cm_roundtrip',
            version:(header&&header.version)||1,
            generated_at:(header&&header.generated_at)||new Date().toISOString(),
            site_url:(header&&header.site_url)||'',
            product_count:products.length,
            products
        };
    }
    async function generateRoundtrip(){
        const ov=document.getElementById('rt-overlay'),ot=document.getElementById('rt-overlay-text'),btn=document.getElementById('btn-rt-export'),sp=document.getElementById('rt-spin');
        ot.textContent='Conteggio prodotti...';ov.classList.add('visible');btn.disabled=true;sp.style.display='';
        beginRun(); await acquireWakeLock();
        try{
            const filters=JSON.stringify(getFilters('rt'));
            const idr=await ajax('rp_cm_ajax_export_roundtrip_ids',{filters});
            if(!idr.success){toast('Errore conteggio: '+(typeof idr.data==='string'?idr.data:'sconosciuto'),'err',0);return}
            const ids=idr.data.ids||[];
            if(!ids.length){toast('Nessun prodotto per questi filtri','inf');return}
            const data=await exportRoundtripChunked(ids,(done,total)=>{ot.textContent='Export '+done+' / '+total+'...';});
            state.roundtripData=data;
            const j=JSON.stringify(data,null,2);
            document.getElementById('btn-rt-copy').style.display='';
            document.getElementById('btn-rt-download').style.display='';
            document.getElementById('rt-size').textContent=fileSize(new Blob([j]).size)+' \u00b7 '+data.product_count+' prodotti';
            toast('Export: '+data.product_count+' prodotti','ok')
        }catch(e){toast('Errore export: '+(e.message||e),'err',0)}
        finally{endRun();releaseWakeLock();ov.classList.remove('visible');btn.disabled=false;sp.style.display='none'}
    }

    // Public ("Export JSON" in Filtra & Agisci, via GH.exportSelectionAsFile):
    // riceve gli ID selezionati, scarica a chunk e fa partire il download.
    // Guard + wake lock perche su 600+ prodotti dura minuti.
    async function exportSelectionAsFile(ids){
        if(!ids||!ids.length){toast('Nessun prodotto selezionato','err');return}
        beginRun(); await acquireWakeLock();
        toast('Export JSON: '+ids.length+' prodotti...','ok',2500);
        try{
            const data=await exportRoundtripChunked(ids);
            const json=JSON.stringify(data,null,2);
            const blob=new Blob([json],{type:'application/json;charset=utf-8'});
            const url=URL.createObjectURL(blob);
            const a=document.createElement('a');
            const stamp=new Date().toISOString().slice(0,19).replace(/[:T]/g,'-');
            a.href=url;a.download='roundtrip-subset-'+ids.length+'-'+stamp+'.json';
            document.body.appendChild(a);a.click();
            setTimeout(()=>{URL.revokeObjectURL(url);a.remove();},100);
            toast('Export di '+data.product_count+' prodotti scaricato','ok')
        }catch(e){toast('Errore export: '+(e.message||e),'err',0)}
        finally{endRun();releaseWakeLock();}
    }

    // ── ROUNDTRIP IMPORT
    function initRtImport(){const drop=document.getElementById('rt-drop'),inp=document.getElementById('rt-file-input');inp.addEventListener('change',()=>{if(inp.files.length)handleRtFile(inp.files[0])});drop.addEventListener('dragover',e=>{e.preventDefault();drop.classList.add('dragover')});drop.addEventListener('dragleave',()=>drop.classList.remove('dragover'));drop.addEventListener('drop',e=>{e.preventDefault();drop.classList.remove('dragover');if(e.dataTransfer.files.length)handleRtFile(e.dataTransfer.files[0])})}
    function handleRtFile(f){if(!f.name.endsWith('.json')){toast('Solo .json','err');return}const r=new FileReader();r.onload=()=>{try{const d=JSON.parse(r.result);if(d.format!=='rp_cm_roundtrip'){toast('Formato non valido','err');return}state.importJSON=d;document.getElementById('rt-file-name').textContent=f.name+' \u00b7 '+(d.product_count||d.products?.length||0)+' prodotti';document.getElementById('rt-mode-row').style.display='flex';document.getElementById('rt-preview-area').innerHTML='';document.getElementById('rt-confirm-bar').style.display='none';toast('File caricato','inf')}catch(e){toast('JSON non valido','err')}};r.readAsText(f)}
    // Invia i prodotti del roundtrip a chunk invece di un unico payload da 15MB
    // che supererebbe il timeout (Cloudflare 524 / PHP-FastCGI). Batch a "peso"
    // (1 + n_varianti) e non a numero fisso: un prodotto con molte varianti =
    // molte scritture WC, quindi 50 prodotti possono sforare 100s lo stesso.
    // Uniamo summary (somma dei contatori) e details.
    const RT_WEIGHT_BUDGET = 80;
    function rtWeight(p){ return 1 + ((p && p.variations && p.variations.length) || 0); }
    async function rtRunChunked(action, mode, onProgress){
        const all = state.importJSON.products || [];
        const total = all.length;
        const merged = { summary:{}, details:[] };
        let i = 0, done = 0, batchNo = 0;
        while (i < total) {
            let w = 0, j = i;
            while (j < total && (j === i || w + rtWeight(all[j]) <= RT_WEIGHT_BUDGET)) { w += rtWeight(all[j]); j++; }
            const slice = all.slice(i, j);
            const payload = { format:'rp_cm_roundtrip', version:1, products:slice };
            batchNo++;
            // Retry per-chunk: un 524/timeout transitorio su un batch non deve
            // buttare a terra l'intera operazione (backoff 1s/2s).
            let r = null;
            for (let attempt = 0; attempt < 3; attempt++) {
                r = await ajax(action, { json_payload: JSON.stringify(payload), mode });
                if (r.success) break;
                if (attempt < 2) { await new Promise(res => setTimeout(res, 1000 * (attempt + 1))); }
            }
            if (!r.success) {
                const detail = (typeof r.data === 'string' && r.data) ? r.data : 'errore sconosciuto';
                throw new Error('batch ' + batchNo + ' (prodotti ' + (i + 1) + '\u2013' + j + '): ' + detail);
            }
            const s = r.data.summary || {};
            for (const k in s) { if (typeof s[k] === 'number') merged.summary[k] = (merged.summary[k] || 0) + s[k]; }
            if (Array.isArray(r.data.details)) merged.details.push(...r.data.details);
            done += slice.length; i = j;
            if (onProgress) onProgress(done, total);
        }
        return merged;
    }
    async function importPreview(){
        if(!state.importJSON)return;
        const btn=document.getElementById('btn-rt-preview'),sp=document.getElementById('preview-spin');
        const ov=document.getElementById('rt-overlay'),ot=document.getElementById('rt-overlay-text');
        btn.disabled=true;sp.style.display='';ot.textContent='Anteprima...';ov.classList.add('visible');
        beginRun(); await acquireWakeLock();
        try{
            const m=document.querySelector('input[name="import-mode"]:checked').value;
            const data=await rtRunChunked('rp_cm_ajax_import_preview',m,(done,total)=>{ot.textContent='Anteprima '+done+' / '+total+'...';});
            const s=data.summary,a=document.getElementById('rt-preview-area');
            let h='<table class="ptable"><thead><tr><th>Stato</th><th>ID</th><th>SKU</th><th>Nome</th><th>Modifiche</th></tr></thead><tbody>';
            for(const d of data.details){const c=d.status==='matched'?'st-matched':d.status==='would_create'?'st-create':'st-skipped';const l=d.status==='matched'?(d.changes.length?'\u2713 mod':'\u2713 ok'):d.status==='would_create'?'+ nuovo':'\u2013 skip';const ch=d.changes?.map(c=>c.field).join(', ')||(d.reason||'');h+='<tr><td class="'+c+'">'+l+'</td><td>'+(d.id||'\u2013')+'</td><td>'+esc(d.sku||'')+'</td><td>'+esc(d.name||'')+'</td><td><span class="changes-list">'+esc(ch)+'</span></td></tr>'}
            h+='</tbody></table>';a.innerHTML=h;
            if((s.with_changes||0)>0||(s.would_create||0)>0){let msg='<span>'+(s.with_changes||0)+'</span> da aggiornare';if(s.would_create)msg+=', <span>'+s.would_create+'</span> nuovi';document.getElementById('rt-confirm-text').innerHTML=msg;document.getElementById('rt-confirm-bar').style.display='flex'}else{toast('Nessuna modifica','inf')}
        }catch(e){toast('Errore anteprima: '+(e.message||e),'err',0)}
        finally{endRun();releaseWakeLock();ov.classList.remove('visible');btn.disabled=false;sp.style.display='none'}
    }
    async function importApply(){
        if(!state.importJSON)return;
        const ov=document.getElementById('rt-overlay'),ot=document.getElementById('rt-overlay-text'),btn=document.getElementById('btn-rt-apply'),sp=document.getElementById('apply-spin');
        ot.textContent='Applicazione...';ov.classList.add('visible');btn.disabled=true;sp.style.display='';
        beginRun(); await acquireWakeLock();
        try{
            const m=document.querySelector('input[name="import-mode"]:checked').value;
            const data=await rtRunChunked('rp_cm_ajax_import_apply',m,(done,total)=>{ot.textContent='Applicazione '+done+' / '+total+'...';});
            const s=data.summary,a=document.getElementById('rt-preview-area');
            let h='<table class="ptable"><thead><tr><th>Risultato</th><th>ID</th><th>SKU</th><th>Nome</th></tr></thead><tbody>';
            for(const d of data.details){const c=d.status==='updated'?'st-updated':d.status==='created'?'st-created':d.status==='error'?'st-error':'st-skipped';h+='<tr><td class="'+c+'">'+esc(d.status)+'</td><td>'+(d.id||'\u2013')+'</td><td>'+esc(d.sku||'')+'</td><td>'+esc(d.name||'')+'</td></tr>'}
            h+='</tbody></table>';a.innerHTML=h;document.getElementById('rt-confirm-bar').style.display='none';
            const parts=[];if(s.updated)parts.push(s.updated+' aggiornati');if(s.created)parts.push(s.created+' creati');if(s.skipped)parts.push(s.skipped+' saltati');if(s.errors)parts.push(s.errors+' errori');
            toast(parts.length?parts.join(', '):'Nessuna modifica',s.errors?'err':'ok',5000)
        }catch(e){toast('Errore import: '+(e.message||e),'err',0)}
        finally{endRun();releaseWakeLock();ov.classList.remove('visible');btn.disabled=false;sp.style.display='none'}
    }
    function importCancel(){document.getElementById('rt-confirm-bar').style.display='none';document.getElementById('rt-preview-area').innerHTML=''}

    // ── COPY / DOWNLOAD JSON (solo roundtrip — il catalog export e stato rimosso)
    function copyJSON(mode){const d=state.roundtripData;if(!d){toast('Nessun dato','err');return}navigator.clipboard.writeText(JSON.stringify(d,null,2)).then(()=>toast('Copiato','ok'),()=>toast('Errore','err'))}
    function downloadJSON(mode){const d=state.roundtripData;if(!d)return;const j=JSON.stringify(d,null,2),b=new Blob([j],{type:'application/json'}),u=URL.createObjectURL(b),a=document.createElement('a'),dt=new Date().toISOString().slice(0,10);a.href=u;a.download='rp-roundtrip-'+dt+'.json';a.click();URL.revokeObjectURL(u);toast('Download avviato','inf')}

    // ── HTTP CLIENT
    async function hcExecute(){const btn=document.querySelector('#panel-httpclient .btn-primary'),sp=document.getElementById('hc-spin');btn.disabled=true;sp.style.display='';try{const hdrs=document.getElementById('hc-headers').value;const cfg={url:document.getElementById('hc-url').value,method:document.getElementById('hc-method').value,headers:hdrs?JSON.parse(hdrs):{},body:document.getElementById('hc-body').value};const r=await ajax('rp_rc_ajax_execute',{config:JSON.stringify(cfg)});const out=document.getElementById('hc-response');if(!r.success){out.textContent='Errore: '+r.data;return}let h='<div style="margin-bottom:12px;color:var(--dim)">HTTP '+r.data.status+' \u00b7 '+r.data.duration_ms+'ms</div>';h+=r.data.parsed?hl(JSON.stringify(r.data.parsed,null,2)):esc(r.data.body_raw||'');out.innerHTML=h}catch(e){toast('Errore','err')}finally{btn.disabled=false;sp.style.display='none'}}

    // ── STOCKFIRMATI FEED ──────────────────────────────────
    let sfProducts = null, sfSelected = new Set(), sfDiffData = null, sfAllItems = [];
    let sfPreimportAbort = false;

    // ── SF + GS settings — unified via GH.feedSettings (js-settings.php).
    //
    // The previous per-feed save/load functions had three near-duplicate
    // copies of "regex out the bullet placeholder", three different toast
    // formats, and no way for the user to verify what was actually written.
    // Replaced with a single contract: empty secret input = preserve, real
    // value = save, server returns per-field status (updated|preserved|
    // unchanged|cleared|rejected) which the toast surfaces verbatim.

    const SF_SETTINGS_MAP = {
        url: { input: '#sf-url' },
    };

    const GS_SETTINGS_MAP = {
        url:    { input: '#gs-url' },
        token:  { input: '#gs-token',  hint: '#gs-token-hint' },
        cookie: { input: '#gs-cookie', hint: '#gs-cookie-hint' },
        format: { input: '#gs-format' },
    };

    async function sfLoadSettings() {
        if (!document.getElementById('sf-url')) return;
        await GH.feedSettings.load('stockfirmati', SF_SETTINGS_MAP);
    }

    async function sfSaveSettings() {
        if (!document.getElementById('sf-url')) return;
        const fields = { url: document.getElementById('sf-url').value };
        const result = await GH.feedSettings.save('stockfirmati', fields);
        GH.feedSettings.refreshHints('stockfirmati', SF_SETTINGS_MAP, result);
    }

    async function gsLoadSettings() {
        if (!document.getElementById('gs-url')) return;
        await GH.feedSettings.load('goldensneakers', GS_SETTINGS_MAP);
    }

    async function gsSaveSettings() {
        const $ = id => document.getElementById(id);
        if (!$('gs-url')) return;

        // Empty secret values mean "preserve". The unified save layer
        // enforces that — no client-side bullet-regex needed any more.
        const fields = {
            url:    $('gs-url').value,
            token:  $('gs-token').value,
            cookie: $('gs-cookie').value,
            format: $('gs-format').value,
        };

        const result = await GH.feedSettings.save('goldensneakers', fields);
        GH.feedSettings.refreshHints('goldensneakers', GS_SETTINGS_MAP, result);
        if (result.ok) {
            // Clear secret inputs so the fingerprint hint is the single
            // source of truth for what the server has now.
            $('gs-token').value  = '';
            $('gs-cookie').value = '';
        }
    }

    function sfMarkupModeChange() {
        const mode = document.getElementById('sf-markup-mode').value;
        const inp = document.getElementById('sf-markup-value');
        if (mode === 'none') {
            inp.style.display = 'none'; inp.value = '';
        } else {
            inp.style.display = '';
            inp.placeholder = mode === 'multiply' ? 'es: 3.5' : 'es: 150';
        }
    }

    function sfGetImportMarkup() {
        const mode = document.getElementById('sf-markup-mode').value;
        const raw = parseFloat(document.getElementById('sf-markup-value').value) || 0;
        if (mode === 'none' || raw <= 0) return 1;
        if (mode === 'multiply') return raw;
        if (mode === 'percent') return 1 + raw / 100;
        return 1;
    }

    function sfToggleSource() {
        const type = document.getElementById('sf-source-type').value;
        document.getElementById('sf-source-url-row').style.display = type === 'url' ? '' : 'none';
        document.getElementById('sf-source-file-row').style.display = type === 'file' ? '' : 'none';
    }

    function initSfFeed() {
        const drop = document.getElementById('sf-drop');
        const inp = document.getElementById('sf-file-input');
        if (drop && inp) {
            inp.addEventListener('change', () => { if (inp.files.length) sfUploadFile(inp.files[0]); });
            drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('dragover'); });
            drop.addEventListener('dragleave', () => drop.classList.remove('dragover'));
            drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('dragover'); if (e.dataTransfer.files.length) sfUploadFile(e.dataTransfer.files[0]); });
        }
        sfLoadSettings();
        sfLoadCached();
    }

    async function sfLoadCached() {
        const ov = document.getElementById('sf-overlay'), ot = document.getElementById('sf-overlay-text');
        try {
            const r = await ajax('gh_ajax_fc_load_cached', { config_id: 'stockfirmati' });
            if (!r.success || !r.data || !r.data.products?.length) return;
            sfProducts = r.data.products;
            document.getElementById('sf-csv-rows').textContent = r.data.csv_rows || '?';
            const age = r.data.fetched_at || '';
            toast(r.data.products.length + ' prodotti (cache' + (age ? ' ' + age : '') + ')', 'inf', 3000);
            // The preview (diff vs WooCommerce) can take several seconds on
            // big catalogs — show the overlay so the table is never "empty
            // while silently working" on tab-open.
            ot.textContent = 'Confronto WooCommerce...';
            ov.classList.add('visible');
            const dr = await ajax('gh_ajax_fc_preview', { products: JSON.stringify(sfProducts), config_id: 'stockfirmati', markup: 1 });
            if (dr.success) sfRenderPreview(dr.data);
        } catch (e) { /* silent — no cached data is fine */ }
        finally { ov?.classList.remove('visible'); }
    }

    async function sfFetch() {
        const ov = document.getElementById('sf-overlay'), ot = document.getElementById('sf-overlay-text');
        const btn = document.getElementById('btn-sf-fetch'), sp = document.getElementById('sf-fetch-spin');
        ot.textContent = 'Fetch CSV...';
        ov.classList.add('visible'); btn.disabled = true; sp.style.display = '';
        try {
            const url = document.getElementById('sf-url').value;
            const r = await ajax('gh_ajax_fc_fetch', { url, config_id: 'stockfirmati' });
            if (!r.success) { toast('Errore: ' + r.data, 'err'); return; }
            sfProducts = r.data.products;
            document.getElementById('sf-csv-rows').textContent = r.data.csv_rows;
            toast(r.data.product_count + ' prodotti', 'ok');
            ot.textContent = 'Confronto WooCommerce...';
            const dr = await ajax('gh_ajax_fc_preview', { products: JSON.stringify(sfProducts), config_id: 'stockfirmati', markup: 1 });
            if (!dr.success) { toast('Errore diff', 'err'); return; }
            sfRenderPreview(dr.data);
        } catch (e) { toast('Errore', 'err'); }
        finally { ov.classList.remove('visible'); btn.disabled = false; sp.style.display = 'none'; }
    }

    async function sfUploadFile(file) {
        const ov = document.getElementById('sf-overlay'), ot = document.getElementById('sf-overlay-text');
        ot.textContent = 'Upload e parsing...'; ov.classList.add('visible');
        try {
            const fd = new FormData();
            fd.append('action', 'gh_ajax_fc_upload'); fd.append('config_id', 'stockfirmati');
            fd.append('nonce', NONCE); fd.append('csv_file', file);
            const resp = await fetch(AJAX, { method: 'POST', body: fd });
            const r = await resp.json();
            if (!r.success) { toast('Errore: ' + r.data, 'err'); return; }
            document.getElementById('sf-file-name').textContent = file.name + ' \u00b7 ' + r.data.csv_rows + ' righe \u00b7 ' + r.data.product_count + ' prodotti';
            sfProducts = r.data.products;
            document.getElementById('sf-csv-rows').textContent = r.data.csv_rows;
            toast(r.data.product_count + ' prodotti', 'ok');
            ot.textContent = 'Confronto WooCommerce...';
            const dr = await ajax('gh_ajax_fc_preview', { products: JSON.stringify(sfProducts), config_id: 'stockfirmati', markup: 1 });
            if (!dr.success) { toast('Errore diff', 'err'); return; }
            sfRenderPreview(dr.data);
        } catch (e) { toast('Errore', 'err'); }
        finally { ov.classList.remove('visible'); }
    }

    function sfRenderPreview(d) {
        const s = d.summary; sfDiffData = d;
        document.getElementById('sf-stats').style.display = 'flex';
        document.getElementById('sf-total').textContent = s.total;
        document.getElementById('sf-new').textContent = s.new;
        document.getElementById('sf-update').textContent = s.update;
        document.getElementById('sf-unchanged').textContent = s.unchanged;
        sfAllItems = [...d.new.map(p => ({...p, _a: 'new'})), ...d.update.map(p => ({...p, _a: 'update'})), ...d.unchanged.map(p => ({...p, _a: 'unchanged'}))];
        sfSelected = new Set(sfAllItems.filter(p => p._a !== 'unchanged').map(p => p.sku));
        document.getElementById('sf-search').value = '';
        document.getElementById('sf-sel-bar').style.display = 'flex';
        sfRenderTable(sfAllItems);
        sfUpdateSelCount(); sfUpdateConfirm();
    }

    function sfRenderTable(items) {
        let h = '<table class="ptable"><thead><tr><th style="width:28px"><input type="checkbox" id="sf-check-all" onchange="GH.sfToggleAll(this.checked)" /></th><th>Azione</th><th>SKU</th><th>Nome</th><th>Brand</th><th>Cat</th><th>Taglie</th><th>Qty</th><th>Costo</th><th>Listino</th><th style="width:60px" title="Hand-off al tab KicksDB Refresh Pricing per la SKU di questa riga">KDB</th></tr></thead><tbody>';
        for (const p of items) {
            const cls = p._a === 'new' ? 'st-new' : p._a === 'update' ? 'st-update' : 'st-unchanged';
            const lb = p._a === 'new' ? '+ Nuovo' : p._a === 'update' ? '\u21bb Agg.' : '\u2713';
            const sz = p.variations ? p.variations.length : 0;
            const brand = p._fc_brand || p._sf_brand || '';
            const cat = (p._fc_category || p._sf_category || '') + ((p._fc_subcategory || p._sf_subcategory) ? ' > ' + (p._fc_subcategory || p._sf_subcategory) : '');
            const ck = sfSelected.has(p.sku) ? 'checked' : '';
            const qty = p.stock_quantity ?? (p.variations ? p.variations.reduce((a, v) => a + (v.stock_quantity || 0), 0) : '?');
            const sale = p.sale_price || (p.variations?.[0]?.sale_price || '');
            const reg = p.regular_price || (p.variations?.[0]?.regular_price || '');
            const skuJs = (p.sku || '').replace(/'/g, "\\'");
            h += '<tr><td><input type="checkbox" class="sf-check" data-sku="' + esc(p.sku) + '" data-type="' + p._a + '" ' + ck + ' onchange="GH.sfToggle(this)" /></td>';
            h += '<td class="' + cls + '">' + lb + '</td><td style="font-size:10px">' + esc(p.sku || '') + '</td>';
            h += '<td>' + esc(p.name || '') + '</td><td>' + esc(brand) + '</td>';
            h += '<td style="font-size:10px">' + esc(cat) + '</td><td>' + sz + '</td><td>' + qty + '</td>';
            h += '<td>' + (sale ? sale + '\u20ac' : '\u2013') + '</td><td style="text-decoration:line-through;color:var(--dim)">' + (reg ? reg + '\u20ac' : '') + '</td>';
            h += '<td><button class="btn btn-ghost" style="font-size:9px;padding:2px 6px" title="Refresh prezzo KicksDB (rispetta conflict rules e tracked flag)" onclick="GH.kdbRefreshSelected([\'' + skuJs + '\'])">\u21bb KDB</button></td></tr>';
        }
        if (!items.length) h += '<tr><td colspan="11" style="text-align:center;color:var(--dim);padding:20px">Nessun risultato</td></tr>';
        h += '</tbody></table>';
        document.getElementById('sf-preview').innerHTML = h;
    }

    function sfFilterList() {
        const q = (document.getElementById('sf-search').value || '').toLowerCase().trim();
        if (!q) { sfRenderTable(sfAllItems); return; }
        const words = q.split(/\s+/);
        const filtered = sfAllItems.filter(p => {
            const haystack = [p.name, p.sku, p._fc_brand || p._sf_brand || '', p._fc_category || p._sf_category || '', p._fc_subcategory || p._sf_subcategory || ''].join(' ').toLowerCase();
            return words.every(w => haystack.includes(w));
        });
        sfRenderTable(filtered);
    }

    function sfToggle(cb) { if (cb.checked) sfSelected.add(cb.dataset.sku); else sfSelected.delete(cb.dataset.sku); sfUpdateSelCount(); sfUpdateConfirm(); }
    function sfToggleAll(on) { document.querySelectorAll('#sf-preview .sf-check').forEach(c => { c.checked = on; if (on) sfSelected.add(c.dataset.sku); else sfSelected.delete(c.dataset.sku); }); sfUpdateSelCount(); sfUpdateConfirm(); }
    function sfSelectAll() { sfAllItems.forEach(p => sfSelected.add(p.sku)); sfRenderTable(sfAllItems); sfUpdateSelCount(); sfUpdateConfirm(); }
    function sfSelectNone() { sfSelected.clear(); sfRenderTable(sfAllItems); sfUpdateSelCount(); sfUpdateConfirm(); }
    function sfSelectByType(type) { sfSelected.clear(); sfAllItems.filter(p => p._a === type).forEach(p => sfSelected.add(p.sku)); sfRenderTable(sfAllItems); sfUpdateSelCount(); sfUpdateConfirm(); }
    function sfUpdateSelCount() { const n = sfSelected.size; document.getElementById('sf-sel-count').textContent = n + ' selezionat' + (n === 1 ? 'o' : 'i'); }
    function sfUpdateConfirm() {
        const bar = document.getElementById('sf-confirm');
        if (!sfSelected.size) { bar.style.display = 'none'; return; }
        let nn = 0, nu = 0;
        sfSelected.forEach(sku => { if (sfDiffData.new.some(p => p.sku === sku)) nn++; else if (sfDiffData.update.some(p => p.sku === sku)) nu++; });
        let msg = '';
        if (nn) msg += '<span>' + nn + '</span> nuov' + (nn === 1 ? 'o' : 'i');
        if (nn && nu) msg += ', ';
        if (nu) msg += '<span>' + nu + '</span> da aggiornare';
        if (!nn && !nu) { bar.style.display = 'none'; return; }
        document.getElementById('sf-confirm-text').innerHTML = msg;
        bar.style.display = 'flex';
    }

    // SF Pre-Import Media: scarica tutte le immagini dei prodotti selezionati
    // nella WP media library PRIMA dell'import. Costruisce una mappa
    // source_url → attachment_id che il product create usa per assegnare
    // featured/gallery senza download.
    async function sfPreimportMedia() {
        if (!sfProducts || !sfSelected.size) { toast('Nessun prodotto selezionato', 'err'); return; }
        const sel = sfProducts.filter(p => sfSelected.has(p.sku));

        // Raccogli tutti gli URL immagine unici.
        // sfProducts ha shape { sku, row: {PICTURE_1, PICTURE_2, ...}, sizes }
        // Le colonne immagine sono PICTURE_1, PICTURE_2, PICTURE_3 (da config SF).
        // Fallback: scansiona tutte le colonne di row che contengono URL http.
        const urlMap = new Map(); // url → sku
        sel.forEach(p => {
            const sku = p.sku || '';
            const row = p.row || {};
            // Try known image columns first
            ['PICTURE_1','PICTURE_2','PICTURE_3','PICTURE_4','PICTURE_5','image_url','image'].forEach(col => {
                const url = (row[col] || '').trim();
                if (url && url.startsWith('http') && !urlMap.has(url)) urlMap.set(url, sku);
            });
            // Also check p.images / p._sf_images (legacy direct SF path)
            (p.images || p._sf_images || []).forEach(url => {
                if (url && !urlMap.has(url)) urlMap.set(url, sku);
            });
        });

        const allUrls = Array.from(urlMap.entries()).map(([url, sku]) => ({ url, sku }));
        if (!allUrls.length) { toast('Nessuna immagine trovata nei prodotti selezionati', 'inf'); return; }

        const total = allUrls.length;
        const batchSize = 50;
        const ov = document.getElementById('sf-overlay'), ot = document.getElementById('sf-overlay-text');
        const btn = document.getElementById('btn-sf-preimport'), sp = document.getElementById('sf-preimport-spin');
        const statusEl = document.getElementById('sf-preimport-status');
        ov.classList.add('visible'); btn.disabled = true; if (sp) sp.style.display = '';
        sfPreimportAbort = false;
        await acquireWakeLock();

        let downloaded = 0, skipped = 0, errors = 0;

        try {
            for (let offset = 0; offset < total; offset += batchSize) {
                if (sfPreimportAbort) { toast('Interrotto. ' + downloaded + ' scaricate finora.', 'inf'); break; }
                const batch = allUrls.slice(offset, offset + batchSize);
                const done = Math.min(offset + batchSize, total);
                ot.textContent = 'Scaricamento immagini ' + done + '/' + total + '... (click Stop per interrompere)';

                const r = await ajax('gh_ajax_preimport_download', {
                    urls: JSON.stringify(batch),
                });

                if (!r.success) {
                    toast('Errore batch immagini: ' + (r.data || ''), 'err');
                    break;
                }

                downloaded += r.data.downloaded || 0;
                skipped    += r.data.skipped || 0;
                errors     += r.data.errors || 0;
            }

            const msg = downloaded + ' scaricate, ' + skipped + ' gia presenti' + (errors ? ', ' + errors + ' errori' : '');
            toast(msg, errors ? 'err' : 'ok', 5000);
            if (statusEl) statusEl.textContent = msg;
        } catch (e) {
            toast('Errore pre-import: ' + (e.message || e), 'err');
        } finally {
            releaseWakeLock(); ov.classList.remove('visible'); btn.disabled = false; if (sp) sp.style.display = 'none';
        }
    }

    function sfPreimportStop() { sfPreimportAbort = true; }

    async function sfValidateMap() {
        const btn = document.getElementById('btn-sf-validate-map'), sp = document.getElementById('sf-validate-spin');
        const statusEl = document.getElementById('sf-preimport-status');
        btn.disabled = true; sp.style.display = '';
        try {
            const r = await ajax('gh_ajax_preimport_validate');
            if (!r.success) { toast('Errore: ' + (r.data || ''), 'err'); return; }
            const d = r.data;
            const msg = d.valid + ' valide, ' + d.pruned + ' rimosse';
            if (statusEl) statusEl.textContent = msg;
            toast(msg, d.pruned ? 'inf' : 'ok', 5000);
        } catch (e) { toast('Errore validazione', 'err'); }
        finally { btn.disabled = false; sp.style.display = 'none'; }
    }

    // SF Apply: chunked per evitare timeout su import grandi (2000+ prodotti).
    // Invia batch da 25 prodotti per request. Il PHP processa ogni batch e
    // ritorna i risultati parziali. Il JS accumula e mostra il progresso.
    async function sfApply() {
        if (!sfProducts || !sfSelected.size) return;
        const sel = sfProducts.filter(p => sfSelected.has(p.sku));
        const total = sel.length;
        const chunkSize = 25;
        const ov = document.getElementById('sf-overlay'), ot = document.getElementById('sf-overlay-text');
        const btn = document.getElementById('btn-sf-apply'), sp = document.getElementById('sf-apply-spin');
        ov.classList.add('visible'); btn.disabled = true; sp.style.display = '';
        await acquireWakeLock();

        const sideload = document.getElementById('sf-opt-images')?.checked || false;
        const asDraft = document.getElementById('sf-opt-draft')?.checked || false;
        const opts = {
            create_new: true,
            update_existing: true,
            sideload_images: sideload,
            status: asDraft ? 'draft' : 'publish',
        };

        let allDetails = [];
        let totCreated = 0, totUpdated = 0, totErrors = 0;

        try {
            for (let offset = 0; offset < total; offset += chunkSize) {
                const chunk = sel.slice(offset, offset + chunkSize);
                const done = Math.min(offset + chunkSize, total);
                ot.textContent = 'Importazione ' + done + '/' + total + (sideload ? ' (con immagini)' : '') + '...';

                const r = await ajax('gh_ajax_fc_apply', {
                    config_id: 'stockfirmati',
                    markup: sfGetImportMarkup(),
                    products: JSON.stringify(chunk),
                    options: JSON.stringify(opts),
                });

                if (!r.success) {
                    toast('Errore al batch ' + done + ': ' + (r.data || 'timeout'), 'err');
                    totErrors++;
                    continue;
                }

                allDetails = allDetails.concat(r.data.details || []);
                totCreated += r.data.summary?.created || 0;
                totUpdated += r.data.summary?.updated || 0;
                totErrors  += r.data.summary?.errors || 0;
                if (r.data.partial) toast('Batch ' + done + ': completamento parziale', 'inf');
            }

            // Render combined results
            let h = '<table class="ptable"><thead><tr><th>Risultato</th><th>ID</th><th>SKU</th><th>Nome</th></tr></thead><tbody>';
            for (const d of allDetails) {
                const c = d.action === 'created' ? 'st-created' : d.action === 'updated' ? 'st-updated' : 'st-error';
                const l = d.action === 'created' ? '+ Creato' : d.action === 'updated' ? '\u2713 Agg.' : '\u2717 Err';
                h += '<tr><td class="' + c + '">' + l + '</td><td>' + (d.id || '\u2013') + '</td><td>' + esc(d.sku || '') + '</td><td>' + esc(d.name || '') + '</td></tr>';
            }
            h += '</tbody></table>';
            document.getElementById('sf-preview').innerHTML = h;
            document.getElementById('sf-confirm').style.display = 'none';
            document.getElementById('sf-sel-bar').style.display = 'none';
            toast(totCreated + ' creati, ' + totUpdated + ' aggiornati' + (totErrors ? ', ' + totErrors + ' errori' : '') + (asDraft ? ' (come bozze)' : ''), totErrors ? 'err' : 'ok', 5000);
        } catch (e) { toast('Errore / timeout: ' + (e.message || e), 'err'); }
        finally { releaseWakeLock(); ov.classList.remove('visible'); btn.disabled = false; sp.style.display = 'none'; }
    }

    async function sfQuickPatch() {
        if (!sfProducts || !sfSelected.size) return;
        const sel = sfProducts.filter(p => sfSelected.has(p.sku));
        const total = sel.length;
        const chunkSize = 50;
        const ov = document.getElementById('sf-overlay'), ot = document.getElementById('sf-overlay-text');
        const btn = document.getElementById('btn-sf-quickpatch'), sp = document.getElementById('sf-quickpatch-spin');
        ov.classList.add('visible'); btn.disabled = true; sp.style.display = '';

        let totPatched = 0, totSkipped = 0, totErrors = 0, allDetails = [];
        try {
            for (let offset = 0; offset < total; offset += chunkSize) {
                const chunk = sel.slice(offset, offset + chunkSize);
                const done = Math.min(offset + chunkSize, total);
                ot.textContent = 'Quick patch ' + done + '/' + total + '...';
                const r = await ajax('gh_ajax_fc_quick_patch', {
                    config_id: 'stockfirmati', markup: sfGetImportMarkup(),
                    products: JSON.stringify(chunk),
                });
                if (!r.success) { toast('Errore: ' + (r.data || ''), 'err'); continue; }
                totPatched += r.data.summary?.patched || 0;
                totSkipped += r.data.summary?.skipped || 0;
                totErrors  += r.data.summary?.errors || 0;
                allDetails = allDetails.concat(r.data.details || []);
            }
            let h = '<table class="ptable"><thead><tr><th>Risultato</th><th>ID</th><th>SKU</th><th>Nome</th><th>Variazioni</th></tr></thead><tbody>';
            for (const d of allDetails) {
                const c = d.action === 'patched' ? 'st-updated' : 'st-error';
                const l = d.action === 'patched' ? '\u2713 Patch' : '\u2717 Err';
                h += '<tr><td class="' + c + '">' + l + '</td><td>' + (d.id || '\u2013') + '</td><td>' + esc(d.sku || '') + '</td><td>' + esc(d.name || '') + '</td><td>' + (d.changes || '') + '</td></tr>';
            }
            h += '</tbody></table>';
            document.getElementById('sf-preview').innerHTML = h;
            document.getElementById('sf-confirm').style.display = 'none';
            toast(totPatched + ' aggiornati, ' + totSkipped + ' invariati' + (totErrors ? ', ' + totErrors + ' errori' : ''), totErrors ? 'err' : 'ok', 5000);
        } catch (e) { toast('Errore: ' + (e.message || e), 'err'); }
        finally { ov.classList.remove('visible'); btn.disabled = false; sp.style.display = 'none'; }
    }

    function sfCancel() { document.getElementById('sf-confirm').style.display = 'none'; document.getElementById('sf-sel-bar').style.display = 'none'; }

    // ── CSV FEED ────────────────────────────────────────────
    let csvCurrentFeed = null;   // feed being edited (null = new)
    let csvFeeds = [];           // cached feed list

    async function csvLoadFeeds() {
        const r = await ajax('gh_ajax_csv_list_feeds');
        if (!r.success) { toast('Errore caricamento feed', 'err'); return; }
        csvFeeds = r.data;
        csvRenderList();
    }

    function csvRenderList() {
        const area = document.getElementById('csv-feed-list');
        if (!csvFeeds.length) {
            area.innerHTML = '<div class="empty-state"><div class="empty-icon">&#9783;</div><div class="empty-text">Nessun feed CSV configurato.<br>Crea un nuovo feed per importare prodotti da CSV.</div></div>';
            return;
        }
        let h = '<table class="ptable"><thead><tr><th>Nome</th><th>Sorgente</th><th>Mapper</th><th>Frequenza</th><th>Ultimo run</th><th>Stato</th><th></th></tr></thead><tbody>';
        const schedLabels = { manual: 'Manuale', hourly: 'Ogni ora', twicedaily: '2x/giorno', daily: 'Giornaliero' };
        for (const f of csvFeeds) {
            const src = f.source_type === 'url' ? esc(f.source_url || '').substring(0, 40) + '...' : esc(f.source_path || '');
            const lastRun = f.last_run ? new Date(f.last_run).toLocaleString('it-IT') : '\u2013';
            const lastStatus = f.last_result?.status || '\u2013';
            const statusCls = lastStatus === 'completed' ? 'green' : lastStatus === 'error' ? 'red' : '';
            h += '<tr style="cursor:pointer" onclick="GH.csvEditFeed(\'' + f.id + '\')">';
            h += '<td><strong>' + esc(f.name) + '</strong></td>';
            h += '<td style="font-size:10px;color:var(--dim)">' + f.source_type.toUpperCase() + ': ' + src + '</td>';
            h += '<td style="font-size:10px">' + esc(f.mapping_rule_id || '\u2013') + '</td>';
            h += '<td>' + (schedLabels[f.schedule] || f.schedule) + '</td>';
            h += '<td style="font-size:10px">' + lastRun + '</td>';
            h += '<td class="' + statusCls + '">' + lastStatus + '</td>';
            h += '<td>' +
                '<button class="btn btn-ghost" onclick="event.stopPropagation();GH.csvRunFeedFromList(\'' + f.id + '\',this)">&#9654; Run</button> ' +
                '<button class="btn btn-ghost" onclick="event.stopPropagation();GH.csvScheduleFeed(\'' + f.id + '\',\'' + esc(f.name || f.id) + '\')" title="Schedula questo feed come job ricorrente">&#9202; Schedula</button>' +
                '</td>';
            h += '</tr>';
        }
        h += '</tbody></table>';
        area.innerHTML = h;
    }

    function csvNewFeed() {
        csvCurrentFeed = null;
        csvShowEditor(null);
    }

    async function csvEditFeed(id) {
        const r = await ajax('gh_ajax_csv_get_feed', { feed_id: id });
        if (!r.success) { toast('Feed non trovato', 'err'); return; }
        csvCurrentFeed = r.data;
        csvShowEditor(r.data);
    }

    let csvDetectedColumns = [];  // columns from last test/upload

    async function csvShowEditor(feed) {
        document.getElementById('csv-list-view').style.display = 'none';
        document.getElementById('csv-edit-view').style.display = '';
        csvDetectedColumns = [];

        // Load mapper rules + presets in parallel
        const [rr, pr] = await Promise.all([
            ajax('gh_ajax_mapper_list_rules'),
            ajax('gh_ajax_csv_list_presets'),
        ]);

        const ruleSel = document.getElementById('csv-mapping-rule');
        ruleSel.innerHTML = '<option value="">-- Seleziona regola --</option>';
        if (rr.success) {
            for (const rule of rr.data) {
                const o = document.createElement('option');
                o.value = rule.id;
                o.textContent = rule.name + ' (' + rule.mapping_count + ' campi)';
                ruleSel.appendChild(o);
            }
        }

        const presetSel = document.getElementById('csv-preset');
        presetSel.innerHTML = '<option value="">-- Seleziona preset --</option>';
        if (pr.success) {
            for (const p of pr.data) {
                const o = document.createElement('option');
                o.value = p.id;
                o.textContent = p.name + ' (' + p.fields + ' campi)';
                o.dataset.desc = p.description;
                presetSel.appendChild(o);
            }
        }

        // Populate form
        if (feed) {
            document.getElementById('csv-edit-title').textContent = 'Modifica: ' + feed.name;
            document.getElementById('csv-name').value = feed.name || '';
            document.getElementById('csv-source-type').value = feed.source_type || 'url';
            document.getElementById('csv-source-url').value = feed.source_url || '';
            document.getElementById('csv-file-name').textContent = feed.source_path || '';
            document.getElementById('csv-mapping-mode').value = feed.mapping_mode || 'auto';
            document.getElementById('csv-preset').value = feed.preset_id || '';
            document.getElementById('csv-mapping-rule').value = feed.mapping_rule_id || '';
            document.getElementById('csv-schedule').value = feed.schedule || 'manual';
            document.getElementById('csv-opt-create').checked = feed.options?.create_new !== false;
            document.getElementById('csv-opt-update').checked = feed.options?.update_existing !== false;
            document.getElementById('btn-csv-preview').style.display = '';
            document.getElementById('btn-csv-run').style.display = '';
            document.getElementById('btn-csv-delete').style.display = '';
        } else {
            document.getElementById('csv-edit-title').textContent = 'Nuovo Feed CSV';
            document.getElementById('csv-name').value = '';
            document.getElementById('csv-source-type').value = 'url';
            document.getElementById('csv-source-url').value = '';
            document.getElementById('csv-file-name').textContent = '';
            document.getElementById('csv-mapping-mode').value = 'auto';
            document.getElementById('csv-preset').value = '';
            document.getElementById('csv-mapping-rule').value = '';
            document.getElementById('csv-schedule').value = 'manual';
            document.getElementById('csv-opt-create').checked = true;
            document.getElementById('csv-opt-update').checked = true;
            document.getElementById('btn-csv-preview').style.display = 'none';
            document.getElementById('btn-csv-run').style.display = 'none';
            document.getElementById('btn-csv-delete').style.display = 'none';
        }
        csvToggleSource();
        csvToggleMapping();
        document.getElementById('csv-source-preview').style.display = 'none';
        document.getElementById('csv-mapping-preview').style.display = 'none';
        document.getElementById('csv-results-area').innerHTML = '';
    }

    function csvBackToList() {
        document.getElementById('csv-edit-view').style.display = 'none';
        document.getElementById('csv-list-view').style.display = '';
        csvLoadFeeds();
    }

    function csvToggleSource() {
        const type = document.getElementById('csv-source-type').value;
        document.getElementById('csv-source-url-row').style.display = type === 'url' ? '' : 'none';
        document.getElementById('csv-source-file-row').style.display = type === 'file' ? '' : 'none';
    }

    function csvToggleMapping() {
        const mode = document.getElementById('csv-mapping-mode').value;
        document.getElementById('csv-preset-row').style.display = mode === 'preset' ? '' : 'none';
        document.getElementById('csv-rule-row').style.display = mode === 'rule' ? '' : 'none';
        // Auto-show mapping preview if we have columns
        if (csvDetectedColumns.length) csvShowMappingPreview();
    }

    async function csvTestUrl() {
        const url = document.getElementById('csv-source-url').value;
        if (!url) { toast('Inserisci URL', 'err'); return; }
        const sp = document.getElementById('csv-test-spin');
        sp.style.display = '';
        try {
            const r = await ajax('gh_ajax_csv_parse_url', { url: url, headers: '{}' });
            if (!r.success) { toast('Errore: ' + r.data, 'err'); return; }
            csvDetectedColumns = r.data.columns || [];
            csvShowSourcePreview(r.data);
            csvShowMappingPreview();
            toast(r.data.rows + ' righe, ' + r.data.columns.length + ' colonne', 'ok');
        } catch (e) { toast('Errore connessione', 'err'); }
        finally { sp.style.display = 'none'; }
    }

    function csvShowSourcePreview(data) {
        document.getElementById('csv-source-preview').style.display = '';
        document.getElementById('csv-columns-list').textContent = data.columns.join(', ');
        if (data.sample && data.sample.length) {
            let h = '<table class="ptable" style="font-size:10px"><thead><tr>';
            for (const col of data.columns) h += '<th>' + esc(col) + '</th>';
            h += '</tr></thead><tbody>';
            for (const row of data.sample) {
                h += '<tr>';
                for (const col of data.columns) h += '<td>' + esc(String(row[col] ?? '')) + '</td>';
                h += '</tr>';
            }
            h += '</tbody></table>';
            document.getElementById('csv-sample-table').innerHTML = h;
        }
    }

    async function csvShowMappingPreview() {
        if (!csvDetectedColumns.length) { document.getElementById('csv-mapping-preview').style.display = 'none'; return; }
        const mode = document.getElementById('csv-mapping-mode').value;
        const previewEl = document.getElementById('csv-mapping-preview');
        const listEl = document.getElementById('csv-mapping-preview-list');

        if (mode === 'auto') {
            const r = await ajax('gh_ajax_csv_auto_map', { columns: JSON.stringify(csvDetectedColumns) });
            if (!r.success) { previewEl.style.display = 'none'; return; }
            let h = '<table class="ptable" style="font-size:10px"><thead><tr><th>Colonna CSV</th><th>&rarr;</th><th>Campo WooCommerce</th><th>Trasformazioni</th></tr></thead><tbody>';
            for (const m of r.data.mappings) {
                if (!m.source) continue;
                const trs = m.transforms?.map(t => t.type).join(', ') || '\u2013';
                h += '<tr><td><strong>' + esc(m.source) + '</strong></td><td>&rarr;</td><td>' + esc(m.target_label || m.target) + '</td><td style="color:var(--dim)">' + esc(trs) + '</td></tr>';
            }
            if (r.data.unmatched_columns?.length) {
                h += '<tr><td colspan="4" style="color:var(--amb);padding-top:8px">Non mappate: ' + esc(r.data.unmatched_columns.join(', ')) + '</td></tr>';
            }
            h += '</tbody></table>';
            listEl.innerHTML = h;
            previewEl.style.display = '';
        } else if (mode === 'preset') {
            const presetId = document.getElementById('csv-preset').value;
            if (!presetId) { previewEl.style.display = 'none'; return; }
            const r = await ajax('gh_ajax_csv_resolve_preset', { preset_id: presetId, columns: JSON.stringify(csvDetectedColumns) });
            if (!r.success) { previewEl.style.display = 'none'; return; }
            let h = '<div style="margin-bottom:6px;color:var(--acc)">' + esc(r.data.preset_name) + ' \u2014 ' + r.data.resolved + '/' + r.data.total_in_preset + ' campi risolti</div>';
            h += '<table class="ptable" style="font-size:10px"><thead><tr><th>Colonna CSV</th><th>&rarr;</th><th>Campo WooCommerce</th><th>Trasformazioni</th></tr></thead><tbody>';
            for (const m of r.data.mappings) {
                if (!m.source) continue;
                const trs = m.transforms?.map(t => t.type + (t.value ? '(' + t.value + ')' : '')).join(', ') || '\u2013';
                h += '<tr><td><strong>' + esc(m.source) + '</strong></td><td>&rarr;</td><td>' + esc(m.target_label || m.target) + '</td><td style="color:var(--dim)">' + esc(trs) + '</td></tr>';
            }
            h += '</tbody></table>';
            listEl.innerHTML = h;
            previewEl.style.display = '';
        } else {
            previewEl.style.display = 'none';
        }
    }

    function initCsvUpload() {
        const drop = document.getElementById('csv-drop');
        const inp = document.getElementById('csv-file-input');
        if (!drop || !inp) return;
        inp.addEventListener('change', () => { if (inp.files.length) csvUploadFile(inp.files[0]); });
        drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('dragover'); });
        drop.addEventListener('dragleave', () => drop.classList.remove('dragover'));
        drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('dragover'); if (e.dataTransfer.files.length) csvUploadFile(e.dataTransfer.files[0]); });
    }

    async function csvUploadFile(file) {
        const ext = file.name.split('.').pop().toLowerCase();
        if (!['csv', 'tsv', 'txt'].includes(ext)) { toast('Solo .csv, .tsv, .txt', 'err'); return; }
        const fd = new FormData();
        fd.append('action', 'gh_ajax_csv_upload');
        fd.append('nonce', NONCE);
        fd.append('csv_file', file);
        try {
            const resp = await fetch(AJAX, { method: 'POST', body: fd });
            const r = await resp.json();
            if (!r.success) { toast('Errore: ' + r.data, 'err'); return; }
            document.getElementById('csv-file-name').textContent = r.data.filename + ' \u00b7 ' + r.data.rows + ' righe';
            document.getElementById('csv-file-input').dataset.path = r.data.path;
            csvDetectedColumns = r.data.columns || [];
            csvShowSourcePreview(r.data);
            csvShowMappingPreview();
            toast(r.data.rows + ' righe caricate', 'ok');
        } catch (e) { toast('Errore upload', 'err'); }
    }

    function csvBuildFeedData() {
        const sourceType = document.getElementById('csv-source-type').value;
        const mappingMode = document.getElementById('csv-mapping-mode').value;
        return {
            id: csvCurrentFeed?.id || '',
            name: document.getElementById('csv-name').value || 'Feed CSV',
            source_type: sourceType,
            source_url: sourceType === 'url' ? document.getElementById('csv-source-url').value : '',
            source_path: sourceType === 'file' ? (document.getElementById('csv-file-input').dataset.path || csvCurrentFeed?.source_path || '') : '',
            source_headers: {},
            mapping_mode: mappingMode,
            preset_id: mappingMode === 'preset' ? document.getElementById('csv-preset').value : '',
            mapping_rule_id: mappingMode === 'rule' ? document.getElementById('csv-mapping-rule').value : '',
            schedule: document.getElementById('csv-schedule').value,
            status: 'active',
            options: {
                create_new: document.getElementById('csv-opt-create').checked,
                update_existing: document.getElementById('csv-opt-update').checked,
            },
        };
    }

    async function csvSaveFeed() {
        const data = csvBuildFeedData();
        if (!data.name) { toast('Nome obbligatorio', 'err'); return; }
        if (data.source_type === 'url' && !data.source_url) { toast('URL obbligatorio', 'err'); return; }
        if (data.source_type === 'file' && !data.source_path) { toast('Carica un file CSV', 'err'); return; }
        if (data.mapping_mode === 'preset' && !data.preset_id) { toast('Seleziona un preset', 'err'); return; }
        if (data.mapping_mode === 'rule' && !data.mapping_rule_id) { toast('Seleziona una regola mapper', 'err'); return; }

        const sp = document.getElementById('csv-save-spin');
        sp.style.display = '';
        try {
            const r = await ajax('gh_ajax_csv_save_feed', { feed: JSON.stringify(data) });
            if (!r.success) { toast('Errore: ' + r.data, 'err'); return; }
            csvCurrentFeed = r.data;
            toast('Feed salvato', 'ok');
            // Show action buttons after save
            document.getElementById('btn-csv-preview').style.display = '';
            document.getElementById('btn-csv-run').style.display = '';
            document.getElementById('btn-csv-delete').style.display = '';
            document.getElementById('csv-edit-title').textContent = 'Modifica: ' + r.data.name;
        } catch (e) { toast('Errore', 'err'); }
        finally { sp.style.display = 'none'; }
    }

    async function csvDeleteFeed() {
        if (!csvCurrentFeed?.id) return;
        if (!confirm('Eliminare il feed "' + csvCurrentFeed.name + '"?')) return;
        const r = await ajax('gh_ajax_csv_delete_feed', { feed_id: csvCurrentFeed.id });
        if (!r.success) { toast('Errore', 'err'); return; }
        toast('Feed eliminato', 'ok');
        csvBackToList();
    }

    async function csvPreview() {
        if (!csvCurrentFeed?.id) { toast('Salva il feed prima di fare preview', 'err'); return; }
        const ov = document.getElementById('csv-overlay'), ot = document.getElementById('csv-overlay-text');
        const sp = document.getElementById('csv-preview-spin');
        ot.textContent = 'Lettura CSV e mapping...';
        ov.classList.add('visible');
        sp.style.display = '';
        try {
            const r = await ajax('gh_ajax_csv_preview', { feed_id: csvCurrentFeed.id });
            if (!r.success) { toast('Errore: ' + r.data, 'err'); return; }
            csvRenderDiff(r.data.diff, r.data.rows_read);
        } catch (e) { toast('Errore', 'err'); }
        finally { ov.classList.remove('visible'); sp.style.display = 'none'; }
    }

    function csvRenderDiff(diff, rowsRead) {
        const s = diff.summary;
        const area = document.getElementById('csv-results-area');
        let h = '<div class="stats-bar" style="display:flex;margin:12px 0">';
        h += '<div class="stat">Righe CSV: <span class="blue">' + rowsRead + '</span></div>';
        h += '<div class="stat">Nuovi: <span class="blue">' + s.new + '</span></div>';
        h += '<div class="stat">Da aggiornare: <span class="amber">' + s.update + '</span></div>';
        h += '<div class="stat">Invariati: <span class="green">' + s.unchanged + '</span></div>';
        h += '</div>';

        const all = [
            ...diff.new.map(p => ({ ...p, _a: 'new' })),
            ...diff.update.map(p => ({ ...p, _a: 'update' })),
            ...diff.unchanged.map(p => ({ ...p, _a: 'unchanged' })),
        ];

        if (all.length) {
            h += '<table class="ptable"><thead><tr><th>Azione</th><th>SKU</th><th>Nome</th><th>Prezzo</th><th>Stock</th><th>Modifiche</th></tr></thead><tbody>';
            for (const p of all.slice(0, 100)) {
                const cls = p._a === 'new' ? 'st-new' : p._a === 'update' ? 'st-update' : 'st-unchanged';
                const lb = p._a === 'new' ? '+ Nuovo' : p._a === 'update' ? '\u21bb Agg.' : '\u2713';
                const changes = p._changes ? p._changes.join(', ') : '';
                h += '<tr>';
                h += '<td class="' + cls + '">' + lb + '</td>';
                h += '<td>' + esc(p.sku || '\u2013') + '</td>';
                h += '<td>' + esc(p.name || '\u2013') + '</td>';
                h += '<td>' + esc(String(p.regular_price || p.sale_price || '\u2013')) + '</td>';
                h += '<td>' + (p.stock_quantity != null ? p.stock_quantity : '\u2013') + '</td>';
                h += '<td style="font-size:10px;color:var(--dim)">' + esc(changes) + '</td>';
                h += '</tr>';
            }
            if (all.length > 100) h += '<tr><td colspan="6" style="text-align:center;color:var(--dim)">... e altri ' + (all.length - 100) + '</td></tr>';
            h += '</tbody></table>';
        }

        area.innerHTML = h;
    }

    async function csvRunFeed() {
        if (!csvCurrentFeed?.id) { toast('Salva il feed prima', 'err'); return; }
        if (!confirm('Eseguire l\'importazione?')) return;
        const ov = document.getElementById('csv-overlay'), ot = document.getElementById('csv-overlay-text');
        const sp = document.getElementById('csv-run-spin');
        ot.textContent = 'Importazione in corso...';
        ov.classList.add('visible');
        sp.style.display = '';
        try {
            const r = await ajax('gh_ajax_csv_run', { feed_id: csvCurrentFeed.id, options: '{}' });
            if (!r.success) { toast('Errore: ' + r.data, 'err'); return; }
            const s = r.data.summary;
            const area = document.getElementById('csv-results-area');
            let h = '<div class="stats-bar" style="display:flex;margin:12px 0">';
            h += '<div class="stat">Righe CSV: <span class="blue">' + r.data.rows_read + '</span></div>';
            h += '<div class="stat">Creati: <span class="green">' + s.created + '</span></div>';
            h += '<div class="stat">Aggiornati: <span class="amber">' + s.updated + '</span></div>';
            h += '<div class="stat">Errori: <span class="red">' + s.errors + '</span></div>';
            h += '</div>';

            if (r.data.details?.length) {
                h += '<table class="ptable"><thead><tr><th>Risultato</th><th>ID</th><th>SKU</th><th>Nome</th></tr></thead><tbody>';
                for (const d of r.data.details) {
                    const c = d.action === 'created' ? 'st-created' : d.action === 'updated' ? 'st-updated' : 'st-error';
                    const l = d.action === 'created' ? '+ Creato' : d.action === 'updated' ? '\u2713 Agg.' : '\u2717 Err';
                    h += '<tr><td class="' + c + '">' + l + '</td><td>' + (d.id || '\u2013') + '</td><td>' + esc(d.sku || '') + '</td><td>' + esc(d.name || '') + '</td></tr>';
                }
                h += '</tbody></table>';
            }

            area.innerHTML = h;
            toast(s.created + ' creati, ' + s.updated + ' aggiornati', s.errors ? 'err' : 'ok', 5000);
        } catch (e) { toast('Errore', 'err'); }
        finally { ov.classList.remove('visible'); sp.style.display = 'none'; }
    }

    // Cross-module hand-off: schedula un CSV feed come job ricorrente.
    // Apre la tab Jobs con l'editor pre-popolato (kind=csv_feed, feed_id=X).
    // L'utente deve ancora scegliere il cron e cliccare Salva.
    async function csvScheduleFeed(feedId, feedName) {
        if (typeof GH.jobsNewWithPreset !== 'function') {
            GH.toast('Jobs non caricato', 'err'); return;
        }
        await GH.jobsNewWithPreset({
            kind:   'csv_feed',
            label:  'CSV Feed · ' + (feedName || feedId),
            cron:   '0 6 * * *',   // default: 6am ogni giorno
            params: {
                feed_id: feedId,
                create_new: true,
                update_existing: true,
                sideload_images: false,
            },
        });
    }

    async function csvRunFeedFromList(feedId, btn) {
        if (!confirm('Eseguire importazione per questo feed?')) return;
        btn.disabled = true;
        btn.textContent = '...';
        try {
            const r = await ajax('gh_ajax_csv_run', { feed_id: feedId, options: '{}' });
            if (!r.success) { toast('Errore: ' + r.data, 'err'); return; }
            const s = r.data.summary;
            toast(s.created + ' creati, ' + s.updated + ' aggiornati, ' + s.errors + ' errori', s.errors ? 'err' : 'ok', 5000);
            csvLoadFeeds();
        } catch (e) { toast('Errore', 'err'); }
        finally { btn.disabled = false; btn.textContent = '\u25b6 Run'; }
    }

    function csvOnPresetChange() {
        const sel = document.getElementById('csv-preset');
        const opt = sel.options[sel.selectedIndex];
        document.getElementById('csv-preset-desc').textContent = opt?.dataset?.desc || '';
        if (csvDetectedColumns.length) csvShowMappingPreview();
    }

    // ── SCHEDULER ───────────────────────────────────────────
    let schedEditingId = null;

    async function schedLoad() {
        const r = await ajax('gh_ajax_sched_list');
        if (!r.success) { toast('Errore', 'err'); return; }
        schedRenderList(r.data);
    }

    function schedRenderList(tasks) {
        const area = document.getElementById('sched-task-list');
        if (!tasks.length) {
            area.innerHTML = '<div class="empty-state"><div class="empty-icon">&#9202;</div><div class="empty-text">Nessun task schedulato</div></div>';
            return;
        }
        const schedLabels = { manual: 'Manuale', hourly: 'Ogni ora', twicedaily: '2x/giorno', daily: 'Giornaliero' };
        let h = '<table class="ptable"><thead><tr><th>Stato</th><th>Nome</th><th>Tipo</th><th>Frequenza</th><th>Ultimo run</th><th>Risultato</th><th>Prossimo</th><th>Run</th><th></th></tr></thead><tbody>';
        for (const t of tasks) {
            const active = t.status === 'active';
            const statusCls = active ? 'green' : 'amber';
            const statusLbl = active ? '\u25cf Attivo' : '\u25cb Pausa';
            const feedLbl = t.feed_type === 'config' ? (t.config_id || '?') : 'CSV #' + (t.csv_feed_id || '?');
            const lastRun = t.last_run ? new Date(t.last_run).toLocaleString('it-IT') : '\u2013';
            const lastOk = t.last_result?.status === 'completed';
            const lastRes = t.last_result ? (lastOk ? '<span class="green">' + (t.last_result.created||0) + 'C ' + (t.last_result.updated||0) + 'U</span>' : '<span class="red">' + (t.last_result.error || 'errore') + '</span>') : '\u2013';
            const nextRun = t.next_run ? new Date(t.next_run).toLocaleString('it-IT') : '\u2013';
            const runN = t.run_count || 0;

            h += '<tr>';
            h += '<td class="' + statusCls + '" style="cursor:pointer" onclick="GH.schedToggle(\'' + t.id + '\')">' + statusLbl + '</td>';
            h += '<td><strong>' + esc(t.name) + '</strong></td>';
            h += '<td style="font-size:10px">' + esc(feedLbl) + '</td>';
            h += '<td>' + (schedLabels[t.schedule] || t.schedule) + '</td>';
            h += '<td style="font-size:10px">' + lastRun + '</td>';
            h += '<td style="font-size:10px">' + lastRes + '</td>';
            h += '<td style="font-size:10px">' + nextRun + '</td>';
            h += '<td><button class="btn btn-ghost" onclick="GH.schedRunNow(\'' + t.id + '\',this)">&#9654;</button></td>';
            h += '<td><button class="btn btn-ghost" onclick="GH.schedEditTask(\'' + t.id + '\')">&#9998;</button> <button class="btn btn-ghost" style="color:var(--red)" onclick="GH.schedDeleteTask(\'' + t.id + '\')">&#10005;</button></td>';
            h += '</tr>';
        }
        h += '</tbody></table>';
        area.innerHTML = h;
    }

    async function schedNewTask() {
        schedEditingId = null;
        document.getElementById('sched-editor-title').textContent = 'Nuovo task';
        document.getElementById('sched-name').value = '';
        document.getElementById('sched-feed-type').value = 'config';
        document.getElementById('sched-source-url').value = '';
        document.getElementById('sched-schedule').value = 'daily';
        document.getElementById('sched-opt-create').checked = true;
        document.getElementById('sched-opt-update').checked = true;
        document.getElementById('sched-opt-images').checked = false;
        await schedLoadDropdowns();
        schedToggleFeedType();
        document.getElementById('sched-editor').style.display = '';
    }

    async function schedEditTask(id) {
        const r = await ajax('gh_ajax_sched_list');
        if (!r.success) return;
        const t = r.data.find(x => x.id === id);
        if (!t) { toast('Non trovato', 'err'); return; }
        schedEditingId = id;
        document.getElementById('sched-editor-title').textContent = 'Modifica: ' + t.name;
        document.getElementById('sched-name').value = t.name || '';
        document.getElementById('sched-feed-type').value = t.feed_type || 'config';
        document.getElementById('sched-source-url').value = t.source_url || '';
        document.getElementById('sched-schedule').value = t.schedule || 'daily';
        document.getElementById('sched-opt-create').checked = t.options?.create_new !== false;
        document.getElementById('sched-opt-update').checked = t.options?.update_existing !== false;
        document.getElementById('sched-opt-images').checked = !!t.options?.sideload_images;
        await schedLoadDropdowns();
        document.getElementById('sched-config-id').value = t.config_id || '';
        document.getElementById('sched-csv-feed-id').value = t.csv_feed_id || '';
        schedToggleFeedType();
        document.getElementById('sched-editor').style.display = '';
    }

    async function schedLoadDropdowns() {
        const [cr, fr] = await Promise.all([ajax('gh_ajax_fc_list_configs'), ajax('gh_ajax_csv_list_feeds')]);
        const cs = document.getElementById('sched-config-id');
        cs.innerHTML = '<option value="">-- Seleziona config --</option>';
        if (cr.success) cr.data.forEach(c => { const o = document.createElement('option'); o.value = c.id; o.textContent = c.name; cs.appendChild(o); });
        const fs = document.getElementById('sched-csv-feed-id');
        fs.innerHTML = '<option value="">-- Seleziona CSV feed --</option>';
        if (fr.success) fr.data.forEach(f => { const o = document.createElement('option'); o.value = f.id; o.textContent = f.name; fs.appendChild(o); });
    }

    function schedToggleFeedType() {
        const ft = document.getElementById('sched-feed-type').value;
        document.getElementById('sched-config-row').style.display = ft === 'config' ? '' : 'none';
        document.getElementById('sched-csv-row').style.display = ft === 'csv_feed' ? '' : 'none';
        document.getElementById('sched-source-row').style.display = ft === 'config' ? '' : 'none';
    }

    function schedCancelEdit() { document.getElementById('sched-editor').style.display = 'none'; }

    async function schedSaveTask() {
        const ft = document.getElementById('sched-feed-type').value;
        const data = {
            id: schedEditingId || '',
            name: document.getElementById('sched-name').value,
            feed_type: ft,
            config_id: ft === 'config' ? document.getElementById('sched-config-id').value : '',
            csv_feed_id: ft === 'csv_feed' ? document.getElementById('sched-csv-feed-id').value : '',
            source_type: 'url',
            source_url: document.getElementById('sched-source-url').value,
            schedule: document.getElementById('sched-schedule').value,
            status: 'active',
            options: {
                create_new: document.getElementById('sched-opt-create').checked,
                update_existing: document.getElementById('sched-opt-update').checked,
                sideload_images: document.getElementById('sched-opt-images').checked,
            },
        };
        if (!data.name) { toast('Nome obbligatorio', 'err'); return; }
        const sp = document.getElementById('sched-save-spin');
        sp.style.display = '';
        try {
            const r = await ajax('gh_ajax_sched_save', { task: JSON.stringify(data) });
            if (!r.success) { toast('Errore: ' + r.data, 'err'); return; }
            toast('Task salvato', 'ok');
            document.getElementById('sched-editor').style.display = 'none';
            schedLoad();
        } catch (e) { toast('Errore', 'err'); }
        finally { sp.style.display = 'none'; }
    }

    async function schedDeleteTask(id) {
        if (!confirm('Eliminare questo task?')) return;
        const r = await ajax('gh_ajax_sched_delete', { task_id: id });
        if (!r.success) { toast('Errore', 'err'); return; }
        toast('Eliminato', 'ok');
        schedLoad();
    }

    async function schedToggle(id) {
        const r = await ajax('gh_ajax_sched_toggle', { task_id: id });
        if (!r.success) { toast('Errore', 'err'); return; }
        toast(r.data.status === 'active' ? 'Attivato' : 'In pausa', 'ok');
        schedLoad();
    }

    async function schedRunNow(id, btn) {
        btn.disabled = true; btn.textContent = '...';
        try {
            const r = await ajax('gh_ajax_sched_run', { task_id: id });
            if (!r.success) { toast('Errore: ' + r.data, 'err'); return; }
            const s = r.data.summary || {};
            toast((s.created||0) + ' creati, ' + (s.updated||0) + ' aggiornati, ' + (s.errors||0) + ' errori', s.errors ? 'err' : 'ok', 5000);
            schedLoad();
        } catch (e) { toast('Errore', 'err'); }
        finally { btn.disabled = false; btn.textContent = '\u25b6'; }
    }

    async function schedLoadLog() {
        const r = await ajax('gh_ajax_sched_log', { limit: '50' });
        if (!r.success) { toast('Errore', 'err'); return; }
        const area = document.getElementById('sched-log-area');
        if (!r.data.length) {
            area.innerHTML = '<div class="empty-state"><div class="empty-icon">&#9776;</div><div class="empty-text">Nessun run registrato</div></div>';
            return;
        }
        let h = '<table class="ptable"><thead><tr><th>Quando</th><th>Task</th><th>Stato</th><th>Creati</th><th>Aggiornati</th><th>Errori</th><th>Durata</th></tr></thead><tbody>';
        for (const e of r.data) {
            const cls = e.status === 'completed' ? '' : 'st-error';
            h += '<tr class="' + cls + '">';
            h += '<td style="font-size:10px">' + new Date(e.ran_at).toLocaleString('it-IT') + '</td>';
            h += '<td>' + esc(e.task_name) + '</td>';
            h += '<td class="' + (e.status === 'completed' ? 'green' : 'red') + '">' + esc(e.status) + '</td>';
            h += '<td class="green">' + (e.created || 0) + '</td>';
            h += '<td class="amber">' + (e.updated || 0) + '</td>';
            h += '<td class="red">' + (e.errors || 0) + (e.error_msg ? ' \u2014 ' + esc(e.error_msg) : '') + '</td>';
            h += '<td style="font-size:10px">' + (e.duration ? (e.duration / 1000).toFixed(1) + 's' : '\u2013') + '</td>';
            h += '</tr>';
        }
        h += '</tbody></table>';
        area.innerHTML = h;
    }

    async function schedClearLog() {
        if (!confirm('Svuotare il log?')) return;
        await ajax('gh_ajax_sched_clear_log');
        toast('Log svuotato', 'ok');
        schedLoadLog();
    }

    // ── FEED-SCOPED CLEANUP ─────────────────────────
    async function feedCleanup(source) {
        const cr = await ajax('gh_ajax_feed_count', { source });
        if (!cr.success) { toast('Errore conteggio', 'err'); return; }
        const count = cr.data.count;
        if (!count) { toast('Nessun prodotto ' + source + ' da eliminare', 'inf'); return; }

        const answer = prompt(
            '\u26a0 ATTENZIONE\n\n' +
            'Stai per eliminare TUTTI i ' + count + ' prodotti importati da "' + source + '" (+ varianti).\n' +
            'L\'operazione e irreversibile.\n\n' +
            'Digita "' + source + '" per confermare:'
        );
        if (answer !== source) { toast('Annullato', 'inf'); return; }

        toast('Eliminazione in corso...', 'inf', 2000);
        await acquireWakeLock();
        try {
            const r = await ajax('gh_ajax_feed_cleanup', { source, confirm: source });
            if (!r.success) { toast('Errore: ' + (r.data || ''), 'err'); return; }
            const d = r.data;
            toast(d.deleted + ' prodotti + ' + d.variations + ' varianti eliminati', 'ok', 5000);
        } catch (e) { toast('Errore: ' + (e.message || e), 'err'); }
        finally { releaseWakeLock(); }
    }

    // ── NUCLEAR CLEANUP ─────────────────────────────
    function nucGetTargets() {
        return {
            products:    document.getElementById('nuc-products')?.checked || false,
            media:       document.getElementById('nuc-media')?.checked || false,
            transients:  document.getElementById('nuc-transients')?.checked || false,
            taxonomy:    document.getElementById('nuc-taxonomy')?.checked || false,
            orphan_meta: document.getElementById('nuc-orphans')?.checked || false,
        };
    }

    async function nucPreview() {
        const targets = nucGetTargets();
        if (!Object.values(targets).some(Boolean)) { toast('Seleziona almeno una categoria', 'err'); return; }
        const btn = document.getElementById('btn-nuc-preview'), sp = document.getElementById('nuc-preview-spin');
        btn.disabled = true; sp.style.display = '';
        try {
            const r = await ajax('gh_ajax_nuclear_preview', { targets: JSON.stringify(targets) });
            if (!r.success) { toast('Errore: ' + (r.data || ''), 'err'); return; }
            const d = r.data;
            const area = document.getElementById('nuc-preview-area');
            let h = '<table class="ptable" style="margin:8px 0"><thead><tr><th>Categoria</th><th>Elementi</th><th>Dettaglio</th></tr></thead><tbody>';
            let totalItems = 0;
            for (const [key, info] of Object.entries(d)) {
                const count = typeof info.count === 'number' ? info.count : (info.deleted ?? 0);
                totalItems += count;
                h += '<tr><td style="font-weight:500">' + esc(key) + '</td>';
                h += '<td class="' + (count > 0 ? 'red' : 'green') + '" style="font-family:var(--mono)">' + count + '</td>';
                h += '<td style="font-size:10px;color:var(--dim)">' + esc(info.label || '') + '</td></tr>';
            }
            h += '</tbody></table>';
            if (totalItems > 0) {
                h += '<div style="font-family:var(--mono);font-size:11px;color:var(--red);margin:8px 0">Totale: ' + totalItems + ' elementi da eliminare</div>';
            } else {
                h += '<div style="font-family:var(--mono);font-size:11px;color:var(--grn);margin:8px 0">Niente da eliminare</div>';
            }
            area.innerHTML = h;
            if (totalItems > 0) {
                document.getElementById('nuc-confirm').style.display = 'flex';
                document.getElementById('nuc-confirm-input').value = '';
            }
        } catch (e) { toast('Errore', 'err'); }
        finally { btn.disabled = false; sp.style.display = 'none'; }
    }

    async function nucExecute() {
        const confirmVal = (document.getElementById('nuc-confirm-input').value || '').trim().toUpperCase();
        if (confirmVal !== 'NUCLEAR') { toast('Digita NUCLEAR per confermare', 'err'); return; }
        const targets = nucGetTargets();
        const ov = document.getElementById('nuc-overlay'), ot = document.getElementById('nuc-overlay-text');
        const btn = document.getElementById('btn-nuc-execute'), sp = document.getElementById('nuc-exec-spin');
        const area = document.getElementById('nuc-preview-area');
        ov.classList.add('visible'); btn.disabled = true; sp.style.display = '';
        await acquireWakeLock();

        const steps = [];
        if (targets.products)    steps.push({ key: 'products',    label: 'Prodotti' });
        if (targets.media)       steps.push({ key: 'media',       label: 'Media' });
        if (targets.transients)  steps.push({ key: 'transients',  label: 'Transients' });
        if (targets.taxonomy)    steps.push({ key: 'taxonomy',    label: 'Tassonomie' });
        if (targets.orphan_meta) steps.push({ key: 'orphan_meta', label: 'Dati orfani' });

        const results = {};
        let errors = 0;

        for (let i = 0; i < steps.length; i++) {
            const step = steps[i];
            ot.textContent = '(' + (i + 1) + '/' + steps.length + ') ' + step.label + '...';

            try {
                if (step.key === 'media') {
                    let totalDeleted = 0;
                    let round = 0;
                    while (true) {
                        round++;
                        ot.textContent = '(' + (i + 1) + '/' + steps.length + ') Media — batch ' + round + ' (' + totalDeleted + ' eliminati)...';
                        const r = await ajax('gh_ajax_nuclear_media_chunk', { confirm: 'NUCLEAR' });
                        if (!r.success) { toast('Errore media batch ' + round + ': ' + (r.data || ''), 'err'); errors++; break; }
                        totalDeleted += r.data.deleted || 0;
                        if (r.data.done) break;
                    }
                    results.media = totalDeleted;
                } else {
                    const r = await ajax('gh_ajax_nuclear_step', { step: step.key, confirm: 'NUCLEAR' });
                    if (!r.success) {
                        toast('Errore ' + step.label + ': ' + (r.data || ''), 'err');
                        results[step.key] = 'ERRORE';
                        errors++;
                    } else {
                        results[step.key] = r.data.result;
                    }
                }
            } catch (e) {
                toast('Errore ' + step.label + ': ' + (e.message || 'timeout'), 'err');
                results[step.key] = 'ERRORE';
                errors++;
            }
        }

        let h = '<div style="font-family:var(--mono);font-size:12px;color:' + (errors ? 'var(--amb)' : 'var(--grn)') + ';margin:12px 0">&#10003; Cleanup ' + (errors ? 'completato con ' + errors + ' errori' : 'completato') + '</div>';
        h += '<table class="ptable"><thead><tr><th>Categoria</th><th>Eliminati</th></tr></thead><tbody>';
        for (const [key, val] of Object.entries(results)) {
            const isErr = val === 'ERRORE';
            const n = typeof val === 'number' ? val : (typeof val === 'object' ? (val.deleted ?? val.postmeta ?? JSON.stringify(val)) : val);
            h += '<tr><td>' + esc(key) + '</td><td class="' + (isErr ? 'amber' : 'red') + '" style="font-family:var(--mono)">' + n + '</td></tr>';
        }
        h += '</tbody></table>';
        area.innerHTML = h;
        document.getElementById('nuc-confirm').style.display = 'none';
        releaseWakeLock(); ov.classList.remove('visible'); btn.disabled = false; sp.style.display = 'none';
        toast('Cleanup ' + (errors ? 'parziale' : 'completato'), errors ? 'err' : 'ok', 5000);
    }

    // ── INIT
    // Popola il dropdown "Brand" della Roundtrip export con i brand estratti
    // da product_cat (legacy: brand = categoria di profondita 1). TODO: migrare
    // Roundtrip a product_brand quando verra rifatto il modulo Import.
    (async function(){const r=await ajax('rp_cm_ajax_get_tree_paths');if(!r.success)return;const sel=document.getElementById('rt-filter-brand');if(!sel)return;(r.data.brands||[]).forEach(b=>{const o=document.createElement('option');o.value=b;o.textContent=b;sel.appendChild(o)})})();
    initBulkImport();
    initRtImport();
    // initSfFeed() ends up calling GH.feedSettings.load() (via sfLoadSettings),
    // but at IIFE-execution time:
    //   1) the outer `const GH = (function(){...})()` binding is still in TDZ
    //   2) GH.feedSettings is attached by js-settings.php, which runs only
    //      AFTER this IIFE has returned.
    // Deferring to a macrotask lets both prerequisites land first.
    setTimeout(initSfFeed, 0);
    initCsvUpload();

    // ── FORCE RE-IMPORT (dispatched as background Jobs) ───────────
    // Shared helper: parses the textarea, reads the feed's current tab
    // config, dispatches the one-shot `force_reimport` job and renders
    // a tiny status line with a link to the Jobs tab.
    function parseSkuList(raw) {
        if (!raw) return [];
        return raw
            .split(/[\s,;\n\r\t]+/)
            .map(s => s.trim())
            .filter(Boolean);
    }
    async function dispatchReimport(feedType, cfg, skus, overwriteMedia, statusId) {
        const statusEl = document.getElementById(statusId);
        statusEl.innerHTML = 'Dispatch...';
        const r = await ajax('gh_ajax_reimport_dispatch', {
            feed_type:       feedType,
            feed_config:     JSON.stringify(cfg),
            skus:            JSON.stringify(skus),
            overwrite_media: overwriteMedia ? '1' : '',
        });
        if (!r.success) {
            statusEl.innerHTML = '<span style="color:var(--red)">Errore: ' + esc(r.data || 'dispatch fallito') + '</span>';
            toast(r.data || 'Errore dispatch', 'err');
            return;
        }
        const lbl = r.data.label || 'Ri-importa forzato';
        statusEl.innerHTML = 'Job avviato: <strong>' + esc(lbl) + '</strong> — <a href="#" onclick="GH.switchTab(\'jobs\',document.querySelector(\'[onclick*=\\\'jobs\\\']\'));return false">apri Jobs</a>';
        toast('Job avviato. Apri la tab Jobs per monitorarlo.', 'ok', 5000);
    }

    async function gsReimportDispatch() {
        const skus = parseSkuList(document.getElementById('gs-reimport-skus').value || '');
        if (!skus.length) { toast('Incolla almeno uno SKU', 'err'); return; }
        const cfg = {
            url:    document.getElementById('gs-url').value,
            token:  document.getElementById('gs-token').value,
            cookie: document.getElementById('gs-cookie').value,
            format: document.getElementById('gs-format').value,
        };
        if (!cfg.url || !cfg.token) { toast('Compila URL + Token GS prima di ri-importare', 'err'); return; }
        const po = gsGetPriceOpts();
        cfg.price_mode = po.price_mode;
        cfg.sale_mult  = po.sale_mult;
        const overwriteMedia = document.getElementById('gs-reimport-media').checked;
        if (!confirm('Ri-importare ' + skus.length + ' SKU da Golden Sneakers?\n\n' +
            (overwriteMedia ? 'Media esistenti saranno cancellate (whitelist preservata).\n' : '') +
            'I prodotti verranno eliminati e ricreati. Azione NON reversibile.')) return;
        await dispatchReimport('gs', cfg, skus, overwriteMedia, 'gs-reimport-status');
    }

    async function sfReimportDispatch() {
        const skus = parseSkuList(document.getElementById('sf-reimport-skus').value || '');
        if (!skus.length) { toast('Incolla almeno uno SKU', 'err'); return; }
        const sourceType = document.getElementById('sf-source-type').value;
        const cfg = { url: sourceType === 'url' ? document.getElementById('sf-url').value : '' };
        if (!cfg.url) { toast('Il force re-import SF richiede un URL CSV valido (non upload file)', 'err'); return; }
        const overwriteMedia = document.getElementById('sf-reimport-media').checked;
        if (!confirm('Ri-importare ' + skus.length + ' SKU da StockFirmati?\n\n' +
            (overwriteMedia ? 'Media esistenti saranno cancellate (whitelist preservata).\n' : '') +
            'I prodotti verranno eliminati e ricreati. Azione NON reversibile.')) return;
        await dispatchReimport('sf', cfg, skus, overwriteMedia, 'sf-reimport-status');
    }

    return{ajax,ajaxWithToast,toast,esc,emptyState,statusChip,confirm:ghConfirm,markDirty,clearDirty,isDirty,registerShortcuts,clearShortcuts,registerDeepOpener,updateHash,copyJSON,copyToClipboard,wireDirtyInputs,switchTab,onTabChange,loadTaxonomy,taxSelect,taxToggle,taxCreateRoot,taxAdd,taxRename,taxDelete,loadWhitelist,whitelistAdd,wlCopyAll,wlToggleBulk,wlBulkExport,wlBulkImport,removeWL,addWL,gsFetch,gsApply,gsQuickPatch,gsCancel,gsLabelPreview,gsLabelApply,gsToggle,gsToggleAll,gsSelectAll,gsSelectNone,gsSelectByType,gsPriceModeChange,gsReimportDispatch,gsLoadSettings,gsSaveSettings,sfLoadSettings,sfFetch,sfPreimportMedia,sfPreimportStop,sfValidateMap,sfApply,sfQuickPatch,sfCancel,sfToggle,sfToggleAll,sfSelectAll,sfSelectNone,sfSelectByType,sfToggleSource,sfFilterList,sfSaveSettings,sfMarkupModeChange,sfReimportDispatch,bulkPreview,bulkApply,bulkApplyBackground,bulkCancel,generateRoundtrip,exportSelectionAsFile,importPreview,importApply,importCancel,copyJSON,downloadJSON,hcExecute,csvLoadFeeds,csvNewFeed,csvEditFeed,csvBackToList,csvToggleSource,csvToggleMapping,csvTestUrl,csvSaveFeed,csvDeleteFeed,csvPreview,csvRunFeed,csvRunFeedFromList,csvScheduleFeed,csvOnPresetChange,schedLoad,schedNewTask,schedEditTask,schedSaveTask,schedDeleteTask,schedToggle,schedRunNow,schedToggleFeedType,schedCancelEdit,schedLoadLog,schedClearLog,nucPreview,nucExecute,feedCleanup};
})();
