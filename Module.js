Ext.define('Store.promatic_dashboard_enhancer.Module', {
    extend: 'Ext.Component',
    extensionName: 'promatic_dashboard_enhancer',
    // version es el SemVer de release y se sube a mano: minor por lote de
    // cambios o widget nuevo, patch por fix puntual. moduleBuild (fecha+hora)
    // lo escribe el script de publicación en cada publicación: es el cache-
    // busting del CSS y la traza en consola. No es la versión.
    version: '0.26.1',
    moduleBuild: '2026-10-09-1656',

    statics: {
        DEBUG_STORAGE_KEY: 'promatic_dashboard_enhancer_debug',

        /**
         * Log de diagnóstico (volcados de respuestas de la API, conteos,
         * fuente elegida). Silencioso por defecto para no ensuciar la consola
         * del cliente en una demo. Se activa por navegador desde la consola con
         * localStorage.setItem('promatic_dashboard_enhancer_debug', '1') y F5.
         * Es estático porque se llama desde callbacks donde `this` no es el módulo.
         */
        debugLog: function () {
            var on = false;
            try { on = window.localStorage && localStorage.getItem(this.DEBUG_STORAGE_KEY) === '1'; } catch (e) { /* storage bloqueado */ }
            if (!on) { return; }
            var args = Array.prototype.slice.call(arguments);
            if (typeof args[0] === 'string') { args[0] = '[promatic_dashboard_enhancer] ' + args[0]; }
            console.log.apply(console, args);
        }
    },

    // Fallback de la config runtime si config.json no carga. loadConfig() lo
    // pisa con lo que traiga el JSON (mismo shape) y la config remota puede
    // sobrescribir secciones encima. Cambiar valores acá o en config.json
    // requiere re-publicar.
    DEFAULT_CONFIG: {
        // tripsMaxVehicles se mantiene bajo a propósito: con flotas de más de
        // mil vehículos, cientos de requests individuales a trips en lotes
        // sin pausa tumbaron la sesión de PILOT, incluso con el circuit
        // breaker. Es una mitigación hasta contar con una fuente batch de una
        // sola llamada.
        top5km: { windowDays: 7, activeVehicleCap: 300, tripsMaxVehicles: 30, tripsBatchSize: 4, source: 'trips-v3', count: 5, kmField: 'gps' },
        // Alcance fijo en 'all' (árbol Online completo): ya no hay selector de
        // alcance en la UI. El código de selección con checkbox del panel
        // "Principal" ('pilot-selection') sigue en el archivo pero inerte.
        //
        // maxVehicles es el tope de seguridad para no disparar jobs
        // asíncronos en flotas enormes. El corte es ciego (primeros N del
        // árbol, no por relevancia), así que con flotas mayores al tope
        // varios widgets trabajan sobre una muestra parcial. 1500 cubre con
        // holgura una flota de ~1350 vehículos; si la flota supera el tope,
        // subirlo acá y en config.json.
        fleet: { scope: 'all', maxVehicles: 1500 },
        // Vista activa del panel: 'rac' (renta de autos sueltos) o 'lop'
        // (administrador de flota). Un override en localStorage (modal
        // "Controles") gana sobre este valor.
        //
        // Estructura prevista para la config por capas, de menor a mayor
        // prioridad: Cliente > Unidad (RAC/LOP) > Rol > Usuario. Cada capa
        // aporta las mismas secciones de este objeto y se mezcla encima de la
        // anterior (el mismo merge por sección que ya hace loadConfig). Hoy
        // solo existe la capa base (este objeto + config.json) y el preset
        // `ui.preset` hace de capa "Unidad"; no hay lectura de roles.
        ui: { preset: 'rac' },
        // Widget "Hora Oficial" — zona horaria IANA y locale para formatear.
        clock: { timeZone: 'America/Santiago', locale: 'es-CL', label: 'Hora Oficial' },
        // Ventana del Fleet ECO report. idleThresholdMin: minutos de ralentí
        // acumulado en la ventana sobre los cuales un vehículo cuenta como
        // "ralentí excesivo" en Alertas Generales.
        ecoScore: { windowDays: 8, idleThresholdMin: 120 },
        // Alerta "Salida de territorio nacional" (Alertas Generales): eventos
        // de una notificación creada por la cuenta en PILOT que se dispara
        // cuando un vehículo se detiene en una geocerca de paso fronterizo.
        // eventType es el id de esa notificación (distinto en cada cuenta);
        // sin él la tarjeta queda en "EN DESARROLLO". since (fecha-hora ISO
        // sin zona, hora local del navegador) descarta eventos anteriores,
        // por si la regla se reconfiguró y quedaron eventos de otra versión.
        borderAlert: { eventType: null, windowDays: 30, since: '' },
        // El reporte de infracciones responde msg "Coming soon" pero con
        // success:true y data completa: msg es un texto heredado sin relación
        // con la disponibilidad real del dato.
        violations: { windowDays: 8 },
        // Match sucursal/base para el tooltip del mapa de flota. El mapeo es
        // EXPLÍCITO por cliente, sin inferencia por nombre: no hay señal de
        // texto confiable para deducir qué geocercas son sucursal de qué
        // flota.
        //
        // Cada entrada de clientMap indica qué carpeta de flota (folderMatch:
        // substring sin distinguir mayúsculas, buscado en toda la cadena de
        // ancestros del árbol "Principal") corresponde a qué group_name
        // EXACTOS de geocercas (groupNames) cuentan como sucursal/base. Reusa
        // el nombre de carpeta que ya existe en el árbol del cliente; no
        // exige renombrar nada.
        branches: {
            clientMap: []
        },
        remoteConfig: { url: 'https://qeveneftsqplkbjetwxf.supabase.co', key: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFldmVuZWZ0c3FwbGtiamV0d3hmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTEyMTMzNjIsImV4cCI6MjEwNjc4OTM2Mn0.bFs4o94f9fZT-iHtOUqJY3DuKaxoBNWXb9NpbeOWeuY' },
        // maskPlates=true reemplaza la patente (en PILOT suele ser el "Nombre
        // de Vehículo") por un alias en toda la UI. Está desactivado porque
        // el alias secuencial compartido entre widgets confundía el análisis
        // de flota. Reactivar solo si se pide explícitamente.
        privacy: { maskPlates: false },
        // windowDays: rango que se pide al reporte de cortes de conexión.
        // minGapSeconds: piso de la capa "Cortes largos" (equivale al "Min
        // time (sec)" del reporte nativo, parámetro contr_time); filtra
        // cortes cortos que no reflejan un problema real de cobertura.
        // shortGapMinSeconds/shortGapMaxSeconds: banda de la capa
        // "Intermitencias breves" (candidatos a túnel/subterráneo). El
        // request usa siempre el piso más bajo para traer ambas capas en una
        // sola llamada.
        hotspots: { windowDays: 30, minGapSeconds: 120, shortGapMinSeconds: 10, shortGapMaxSeconds: 90 },
        // Alertas de combustible (cargas/drenajes calculados sobre el
        // reporte de sensor, ver loadFuelAlerts). loadMinPct/drainMinPct son
        // % del nivel máximo observado, no litros: el reporte no declara la
        // unidad. windowMin: duración máxima de un drenaje; maxGapMin: hueco
        // máximo entre dos lecturas para aceptar una carga con el equipo
        // sin reportar. agentIds fija a mano qué vehículos tienen sensor y
        // salta el catálogo. batchSize/pauseMs/maxVehicles acotan la carga
        // sobre PILOT: consultas por lotes chicos con pausa, y como mucho
        // maxVehicles nuevas por ciclo (cacheMinutes evita repetirlas).
        fuel: {
            enabled: true, windowDays: 3, loadMinPct: 10, drainMinPct: 6, windowMin: 30, maxGapMin: 360,
            stopSpeedKmh: 3, minSamples: 5, capacityHint: 0, agentIds: [],
            batchSize: 3, pauseMs: 1000, maxVehicles: 60, cacheMinutes: 30,
            catalogBatch: 20, catalogCacheHours: 24, debugRawMax: 3
        }
    },

    initModule: function () {
        console.log('[promatic_dashboard_enhancer] BUILD ' + this.moduleBuild + ' — initModule: inicio');
        // Circuit breaker por sesión: los endpoints propios que ya dieron 401
        // se saltan (sin fetch) hasta el próximo F5, para no generar tráfico
        // inútil contra rutas bloqueadas para esta cuenta. Solo aplica a
        // llamadas de este código, no a las nativas de PILOT.
        this._blockedEndpoints = {};
        this.config = this.DEFAULT_CONFIG;
        this.loadConfig();
        this.loadStyles();

        var mainPanel = this.buildMainPanel();
        console.log('[promatic_dashboard_enhancer] initModule: mainPanel construido');
        var navTab = this.buildNavTab(mainPanel);

        navTab.map_frame = mainPanel;

        if (window.skeleton && skeleton.navigation && typeof skeleton.navigation.add === 'function') {
            skeleton.navigation.add(navTab);
            console.log('[promatic_dashboard_enhancer] initModule: navTab agregado a skeleton.navigation');
        } else {
            console.log('[promatic_dashboard_enhancer] initModule: skeleton.navigation.add NO disponible todavía');
        }
    },

    buildNavTab: function (mainPanel) {
        var NavTabClass = Ext.ClassManager.get('Pilot.utils.LeftBarPanel') ?
            'Pilot.utils.LeftBarPanel' :
            'Ext.panel.Panel';

        return Ext.create(NavTabClass, {
            title: l('Dashboard Enhancer'),
            iconCls: 'fa fa-th-large',
            iconAlign: 'top',
            minimized: true,
            items: [mainPanel]
        });
    },

    // El layout es un shell de filas flex armado como HTML plano con
    // Ext.DomHelper dentro de un único Ext.Component, sin
    // Ext.container.Container anidados. Un Container con layout 'auto'
    // envuelve cada nivel de hijos en divs propios (outerCt/innerCt, table-
    // layout:fixed) y rompe flexbox: el hijo directo de la fila deja de ser
    // la card.
    //
    // Consecuencia: no hay Ext.Component por card; el contenido se actualiza
    // con updateCardBody(id, html), que ubica el nodo por id con Ext.get().
    buildMainPanel: function () {
        this.summaryBar = Ext.create('Ext.Component', {
            cls: 'promatic_dashboard_enhancer-summary',
            html: l('Cargando estado de flota...')
        });

        var me = this;

        // El panel de una extensión se monta lazy: Ext no crea su DOM hasta
        // que el usuario abre el tab. Si los widgets arrancaran al construir,
        // todos los updateCardBody fallarían porque las cards todavía no
        // existen. Por eso todo arranca en 'afterrender' (una sola vez).
        var panel = Ext.create('Ext.panel.Panel', {
            id: 'promatic_dashboard_enhancer-panel-root',
            // La clase de vista inicial evita el parpadeo de la vista equivocada
            // antes del primer applyViewPreset.
            cls: 'promatic_dashboard_enhancer-panel' + (this.effectiveUiPreset() === 'lop' ? ' ' + this.VIEW_LOP_CLS : ''),
            layout: { type: 'vbox', align: 'stretch' },
            scrollable: 'y',
            items: [this.summaryBar, this.buildRacShell()],
            listeners: {
                afterrender: {
                    single: true,
                    fn: function () {
                        me._lastManualRefresh = new Date();
                        me.bindKmReportLinks(panel);
                        me.bindAlertReportLinks(panel);
                        me.bindControlsBar(panel);
                        me.bindExportBlock(panel);
                        me.bindFleetUpdates();
                        // Con la flota completa los reportes pesados no pueden
                        // salir todos a la vez: ver startInitialLoad.
                        me.startInitialLoad();
                        // Mapa de hotspots: instancia propia de MapContainer
                        // dentro de un Ext.panel.Panel (patrón del ejemplo
                        // oficial examples/airports/Map.js). El listener
                        // 'render' del panel crea el MapContainer y carga los
                        // datos. NUNCA toca window.mapContainer, que es el
                        // mapa global de PILOT.
                        //
                        // applyViewPreset lo construye solo si la vista
                        // activa muestra Hotspots (RAC).
                        me.applyViewPreset();
                        me.buildFleetMapPanel();
                        me.startClock();
                        me.startAutoRefresh();
                        me.renderLogo();
                        // scrollable:'y' de Ext mide el alto scrolleable
                        // contra el navTab contenedor, no contra el contenido
                        // real. En ventanas angostas el shell (flex-wrap)
                        // crece de alto sin que Ext se entere y recorta el
                        // footer sin mostrar scrollbar. Un listener 'resize'
                        // o un defer de timing fijo no bastan: no disparan
                        // cuando el contenido cambia de alto sin que cambie
                        // la ventana. Un ResizeObserver dispara exactamente
                        // cuando cambia el tamaño del contenido, sin adivinar
                        // timing.
                        me._bindPanelResizeObserver(panel);
                    }
                }
            }
        });

        return panel;
    },

    /**
     * Se observa el CONTENIDO interno (.rac-shell), no el panel externo:
     * panel.getEl() devuelve el elemento externo con scrollable:'y', cuyo
     * tamaño visible no cambia aunque el contenido de adentro crezca, así que
     * un observer ahí nunca detecta el desborde. updateLayout() del panel
     * sigue siendo necesario para que Ext remida el alto scrolleable contra
     * el contenido ya crecido.
     */
    _bindPanelResizeObserver: function (panel) {
        var el = panel.getEl && panel.getEl();
        if (!el || !el.dom || typeof ResizeObserver === 'undefined') { return; }
        var shellDom = el.dom.querySelector('.promatic_dashboard_enhancer-rac-shell');
        if (!shellDom) { return; }
        var me = this;
        if (this._panelResizeObserver) { return; }
        this._panelResizeObserver = new ResizeObserver(function () {
            if (me._panelResizeDefer) { clearTimeout(me._panelResizeDefer); }
            me._panelResizeDefer = Ext.defer(function () {
                if (panel.updateLayout) { panel.updateLayout(); }
            }, 120);
        });
        this._panelResizeObserver.observe(shellDom);
    },

    /**
     * Skeleton de carga: barras grises con la forma aproximada del contenido
     * real mientras el widget hace su primer fetch. updateCardBody() lo
     * reemplaza cuando llega el dato (o el widget pinta su propio error). El
     * shimmer se apaga con prefers-reduced-motion.
     *
     * kind: 'donut' (Estado de Flota), 'ranking' (Top KM), 'chips' (Sin Señal
     * GPS), 'stats' (Alertas Generales), 'map' (mapas).
     *
     * Devuelve un SPEC de Ext.DomHelper (objeto), no un string: se anida como
     * `cn` dentro del spec de la card, que buildRacShell renderiza de una
     * pasada. Un string HTML acá se re-escaparía.
     */
    skeletonSpec: function (kind) {
        var bar = function (w, h) {
            return { cls: 'promatic_dashboard_enhancer-sk-bar',
                style: 'width:' + w + ';height:' + (h || 12) + 'px' };
        };
        var block = function (h) {
            return { cls: 'promatic_dashboard_enhancer-sk-bar', style: 'height:' + h + 'px' };
        };
        if (kind === 'donut') {
            return { cls: 'promatic_dashboard_enhancer-sk promatic_dashboard_enhancer-sk--grid2',
                cn: [block(46), block(46), block(46), block(46)] };
        }
        if (kind === 'ranking') {
            return { cls: 'promatic_dashboard_enhancer-sk promatic_dashboard_enhancer-sk--ranking',
                cn: [block(70), bar('80%'), bar('65%'), bar('72%'), bar('50%'), bar('58%')] };
        }
        if (kind === 'chips') {
            return { cls: 'promatic_dashboard_enhancer-sk promatic_dashboard_enhancer-sk--row',
                cn: [block(40), block(40), block(40)] };
        }
        if (kind === 'stats') {
            return { cls: 'promatic_dashboard_enhancer-sk promatic_dashboard_enhancer-sk--col',
                cn: [block(50), block(50), block(50), block(50), block(50), block(50)] };
        }
        if (kind === 'map') {
            return { cls: 'promatic_dashboard_enhancer-sk', cn: [block(320)] };
        }
        return { cls: 'promatic_dashboard_enhancer-sk', cn: [bar('90%'), bar('70%'), bar('80%')] };
    },

    cardMarkup: function (id, opts) {
        opts = opts || {};
        var headCn = [
            { tag: 'h3', cls: 'promatic_dashboard_enhancer-card__title', html: opts.title || '' }
        ];
        if (opts.meta) {
            headCn.push({ tag: 'span', cls: 'promatic_dashboard_enhancer-card__meta', html: opts.meta });
        }
        // El (?) usa el tooltip nativo de Ext (data-qtip). QuickTips está
        // activo en el runtime de PILOT: NO agregar también `title`, porque
        // el navegador dispara su tooltip nativo EN PARALELO al de Ext y se
        // ven 2 superpuestos.
        if (opts.hint) {
            headCn.push({
                tag: 'span',
                cls: 'promatic_dashboard_enhancer-card__hint',
                'data-qtip': opts.hint,
                html: '?'
            });
        }

        var bodySpec = {
            id: 'promatic_dashboard_enhancer-card-body-' + id,
            cls: 'promatic_dashboard_enhancer-card__body'
        };
        if (opts.bodyHtml) {
            bodySpec.html = opts.bodyHtml;
        } else if (opts.skeleton) {
            bodySpec.cn = [this.skeletonSpec(opts.skeleton)];
        } else {
            bodySpec.html = l('Cargando...');
        }

        if (opts.headExtra) {
            headCn.push(opts.headExtra);
        }

        var cn = [
            { cls: 'promatic_dashboard_enhancer-card__head', cn: headCn },
            bodySpec
        ];
        // Las cards puramente informativas (reloj, logo) no llevan pie "Ver
        // en PILOT": no hay nada nativo a lo que enlazar.
        if (!opts.noFooter) {
            cn.push({ cls: 'promatic_dashboard_enhancer-card__footer', cn: [
                { tag: 'a', href: '#', html: (opts.footerLabel || l('Ver en PILOT')) + ' ›' }
            ] });
        }

        return {
            id: 'promatic_dashboard_enhancer-card-' + id,
            cls: 'promatic_dashboard_enhancer-card' + (opts.grow2 ? ' promatic_dashboard_enhancer-card--grow-2' : '') +
                this.viewVisibilityCls(id),
            cn: cn
        };
    },

    /**
     * Reintento acotado (300 ms x 60 = 18 s, nunca infinito): el shell puede
     * no estar en el DOM todavía cuando un widget intenta actualizar su card,
     * sobre todo los que se pintan de inmediato desde buildMainPanel, antes
     * de que Ext termine de montar el panel.
     *
     * optional=true: la card puede no estar montada en el shell actual; en
     * ese caso no reintenta ni avisa.
     */
    updateCardBody: function (id, html, attempt, optional) {
        attempt = attempt || 0;
        var el = Ext.get('promatic_dashboard_enhancer-card-body-' + id);
        if (el) {
            el.setHtml(html);
            // Un pintado real (no el skeleton) marca el fin de la consulta
            // que espera refreshAllWidgets.
            if (!this._paintingSkeleton && this._refreshPending) { delete this._refreshPending[id]; }
        } else if (optional) {
            return;
        } else if (attempt < 60) {
            Ext.defer(this.updateCardBody, 300, this, [id, html, attempt + 1, optional]);
        } else {
            console.warn('[promatic_dashboard_enhancer] updateCardBody("' + id +
                '"): la card no apareció en el DOM tras 18s.');
        }
    },

    rowMarkup: function (cardSpecs) {
        return { cls: 'promatic_dashboard_enhancer-row', cn: cardSpecs };
    },

    /**
     * Apila 2+ cards en una sola celda de la fila. Sigue siendo HTML plano
     * vía DomHelper, sin Ext.container.Container anidado.
     */
    colMarkup: function (cardSpecs) {
        return { cls: 'promatic_dashboard_enhancer-col', cn: cardSpecs };
    },

    /**
     * Bloque "Exportar Reporte / Generar Golden Report" bajo el logo. Genera
     * los documentos a partir de los datos ya calculados en los widgets (no
     * hace requests propios).
     */
    exportBlockMarkup: function () {
        return {
            cls: 'promatic_dashboard_enhancer-export-block',
            cn: [
                {
                    cls: 'promatic_dashboard_enhancer-export-card',
                    cn: [
                        { cls: 'promatic_dashboard_enhancer-export-card__title', html: l('Exportar Reporte') },
                        {
                            tag: 'select', id: 'promatic_dashboard_enhancer-export-widget',
                            cls: 'promatic_dashboard_enhancer-export-card__select',
                            cn: [
                                { tag: 'option', value: 'flota', html: l('Estado de Flota') },
                                { tag: 'option', value: 'top5km', html: l('Exceso de Kilometraje') },
                                { tag: 'option', value: 'eco', html: l('Safety Score (ECO)') },
                                { tag: 'option', value: 'gps', html: l('Sin Señal GPS') },
                                { tag: 'option', value: 'alertas', html: l('Alertas Generales') }
                            ]
                        },
                        {
                            tag: 'button', type: 'button',
                            id: 'promatic_dashboard_enhancer-export-widget-btn',
                            cls: 'promatic_dashboard_enhancer-export-card__btn',
                            html: l('Exportar') + ' ›'
                        }
                    ]
                },
                {
                    cls: 'promatic_dashboard_enhancer-export-card',
                    cn: [
                        { cls: 'promatic_dashboard_enhancer-export-card__title', html: l('Golden Report') },
                        {
                            cls: 'promatic_dashboard_enhancer-export-card__hint',
                            html: l('Resumen semanal de todo el panel + guía para ver la información al detalle en PILOT')
                        },
                        {
                            tag: 'button', type: 'button',
                            id: 'promatic_dashboard_enhancer-golden-btn',
                            cls: 'promatic_dashboard_enhancer-export-card__btn promatic_dashboard_enhancer-export-card__btn--primary',
                            html: l('Generar') + ' ›'
                        }
                    ]
                },
                {
                    cls: 'promatic_dashboard_enhancer-export-card',
                    cn: [{
                        tag: 'button', type: 'button',
                        id: 'promatic_dashboard_enhancer-controls-btn',
                        cls: 'promatic_dashboard_enhancer-export-card__btn',
                        html: l('Controles') + ' ›'
                    }]
                }
            ]
        };
    },

    bindExportBlock: function (panel) {
        var me = this;
        var el = panel && panel.getEl && panel.getEl();
        if (!el || el._exportBound) { return; }
        el._exportBound = true;
        el.on('click', function (e) {
            var wb = e.getTarget('#promatic_dashboard_enhancer-export-widget-btn', 3, true);
            if (wb) {
                e.preventDefault();
                var sel = document.getElementById('promatic_dashboard_enhancer-export-widget');
                var which = sel ? sel.value : 'flota';
                me.openReportModal(me.buildWidgetReport(which), me._widgetReportName(which),
                    me._safe(function () { return me.buildWidgetPdfDoc(which); }));
                return;
            }
            if (e.getTarget('#promatic_dashboard_enhancer-controls-btn', 3, true)) {
                e.preventDefault();
                me.openControlsModal();
                return;
            }
            var gb = e.getTarget('#promatic_dashboard_enhancer-golden-btn', 3, true);
            if (gb) {
                e.preventDefault();
                me.openReportModal(me.buildGoldenReport(), 'Golden Report',
                    me._safe(function () { return me.buildGoldenPdfDoc(); }));
            }
        });
    },

    /**
     * Ejecuta fn y devuelve su resultado, o null si lanza: evita que falle el
     * modal completo si la construcción del docDefinition de pdfMake falla.
     */
    _safe: function (fn) {
        try { return fn(); } catch (e) {
            console.warn('[promatic_dashboard_enhancer] build pdfDoc falló:', e);
            return null;
        }
    },

    _widgetReportName: function (which) {
        return ({
            flota: l('Estado de Flota'), top5km: l('Exceso de Kilometraje'),
            eco: l('Safety Score (ECO)'), gps: l('Sin Señal GPS'),
            alertas: l('Alertas Generales')
        })[which] || this._lopExportTitle(which) || l('Reporte');
    },

    /**
     * Muestra el HTML del reporte en un MODAL (overlay dentro de la página,
     * no una pestaña). El HTML va en un iframe aislado del CSS de PILOT.
     * "Imprimir / Guardar PDF" llama print() del iframe; Esc y "Cerrar"
     * quitan el overlay.
     *
     * mapPoints (opcional): si trae datos se agrega un mapa REAL
     * (MapContainer) entre la barra y el iframe. El iframe es un documento
     * aislado sin acceso a MapContainer ni a Ext, por eso el mapa vive en el
     * overlay padre y las filas del iframe le piden centrar un punto por
     * postMessage.
     *
     * mapOpts (opcional): { showMap, initCenter, notice }. showMap muestra el
     * mapa aunque mapPoints venga vacío (los puntos que no se dibujan de
     * entrada se agregan al hacer clic en "ver en mapa interno"); initCenter
     * {lat, lon} es el centro inicial en ese caso; notice es un aviso corto
     * sobre el mapa (qué puntos se dibujan).
     */
    openReportModal: function (html, title, pdfDoc, mapPoints, mapOpts) {
        var me = this;
        this.closeReportModal();

        // "Descargar PDF" se ofrece siempre que haya docDefinition. pdfMake
        // suele estar en el runtime de PILOT; si no, se carga bajo demanda al
        // hacer clic (ver ensurePdfMake).
        var pdfBtn = pdfDoc
            ? '<button type="button" data-act="pdf" class="promatic_dashboard_enhancer-report-modal__btn promatic_dashboard_enhancer-report-modal__btn--primary">⬇ ' + l('Descargar PDF') + '</button>'
            : '';

        mapOpts = mapOpts || {};
        var hasMap = (Array.isArray(mapPoints) && mapPoints.length > 0) || !!mapOpts.showMap;
        mapPoints = Array.isArray(mapPoints) ? mapPoints : [];
        var mapHtml = hasMap
            ? (mapOpts.notice
                ? '<div class="promatic_dashboard_enhancer-report-modal__map-notice">' + Ext.String.htmlEncode(mapOpts.notice) + '</div>'
                : '') +
              '<div id="promatic_dashboard_enhancer-report-modal-map" class="promatic_dashboard_enhancer-report-modal__map"></div>'
            : '';

        var ov = document.createElement('div');
        ov.id = 'promatic_dashboard_enhancer-report-modal';
        ov.className = 'promatic_dashboard_enhancer-report-modal';
        ov.innerHTML =
            '<div class="promatic_dashboard_enhancer-report-modal__box">' +
                '<div class="promatic_dashboard_enhancer-report-modal__bar">' +
                    '<span class="promatic_dashboard_enhancer-report-modal__title"></span>' +
                    '<span class="promatic_dashboard_enhancer-report-modal__actions">' +
                        pdfBtn +
                        '<button type="button" data-act="print" class="promatic_dashboard_enhancer-report-modal__btn' + (pdfDoc ? '' : ' promatic_dashboard_enhancer-report-modal__btn--primary') + '">🖨 ' + l('Imprimir') + '</button>' +
                        '<button type="button" data-act="close" class="promatic_dashboard_enhancer-report-modal__btn">✕ ' + l('Cerrar') + '</button>' +
                    '</span>' +
                '</div>' +
                mapHtml +
                '<iframe class="promatic_dashboard_enhancer-report-modal__frame" title="' + Ext.String.htmlEncode(title || 'Reporte') + '"></iframe>' +
            '</div>';
        document.body.appendChild(ov);
        me._reportPdfDoc = pdfDoc || null;
        me._reportPdfName = (title || 'reporte').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '.pdf';
        ov.querySelector('.promatic_dashboard_enhancer-report-modal__title').textContent = title || l('Reporte');

        var frame = ov.querySelector('iframe');
        // Se escribe con document.write y no con srcdoc: srcdoc se rompe con
        // comillas dobles en el HTML. No hay navegación, es un iframe
        // about:blank.
        var fd = frame.contentWindow.document;
        fd.open();
        fd.write(html);
        fd.close();

        if (hasMap) { me._buildReportModalMap(mapPoints, mapOpts); }
        // Mensajes del iframe: "ver en mapa interno" centra (y dibuja si
        // falta) el punto pedido; "abrir informe nativo" cierra el modal y
        // abre el informe de PILOT. Un solo listener por apertura; se limpia
        // en closeReportModal.
        me._reportModalMsgHandler = function (ev) {
            if (ev.source !== frame.contentWindow) { return; }
            var data = ev.data || {};
            if (data.type === 'promatic_dashboard_enhancer_focus_point') {
                me._focusReportModalMapPoint(data.lat, data.lon, data.label);
            } else if (data.type === 'promatic_dashboard_enhancer_open_native_report') {
                me._openNativeReportFromModal(Number(data.reportType), Number(data.agentId), Number(data.ts));
            }
        };
        window.addEventListener('message', me._reportModalMsgHandler);

        ov.addEventListener('click', function (ev) {
            var act = ev.target && ev.target.getAttribute && ev.target.getAttribute('data-act');
            if (act === 'close' || ev.target === ov) { me.closeReportModal(); return; }
            if (act === 'pdf') {
                var btn = ev.target;
                var label = btn.innerHTML;
                btn.disabled = true;
                btn.innerHTML = l('Generando…');
                me.ensurePdfMake().then(function (pm) {
                    btn.disabled = false;
                    btn.innerHTML = label;
                    if (!pm) {
                        console.warn('[promatic_dashboard_enhancer] pdfMake no disponible — se usa Imprimir');
                        alert(l('La descarga directa de PDF no está disponible en este navegador/cuenta. Usa el botón "Imprimir" y elige "Guardar como PDF".'));
                        return;
                    }
                    try { pm.createPdf(me._reportPdfDoc).download(me._reportPdfName); }
                    catch (e4) {
                        console.warn('[promatic_dashboard_enhancer] pdfMake.download falló:', e4);
                        alert(l('No se pudo generar el PDF. Usa "Imprimir" → "Guardar como PDF".'));
                    }
                });
                return;
            }
            if (act === 'print') {
                try {
                    frame.contentWindow.focus();
                    // Pequeño respiro para que el layout del iframe esté listo.
                    setTimeout(function () {
                        try { frame.contentWindow.print(); }
                        catch (e3) {
                            console.warn('[promatic_dashboard_enhancer] print del iframe falló, fallback a window.print:', e3);
                            window.print();
                        }
                    }, 60);
                } catch (e2) {
                    console.warn('[promatic_dashboard_enhancer] print del iframe falló:', e2);
                    window.print();
                }
            }
        });
        this._reportModalEsc = function (ev) { if (ev.key === 'Escape') { me.closeReportModal(); } };
        document.addEventListener('keydown', this._reportModalEsc);
    },

    /**
     * Crea el panel MapContainer del modal (mapPoints ya validado como no
     * vacío por el llamador). Mismo patrón que buildFleetMapPanel
     * (Ext.panel.Panel + layout 'fit' + init() + checkResize diferido),
     * adaptado a vivir en el overlay.
     */
    _buildReportModalMap: function (mapPoints, mapOpts) {
        var me = this;
        var body = Ext.get('promatic_dashboard_enhancer-report-modal-map');
        if (!body || !me.getMapContainerClass()) {
            if (body) { body.setHtml(l('El mapa no está disponible en este runtime.')); }
            return;
        }
        me._reportModalMapPoints = mapPoints;
        me._reportModalDrawn = {};
        me._reportModalMapPanel = Ext.create('Ext.panel.Panel', {
            renderTo: body,
            layout: 'fit',
            height: 240,
            border: false,
            listeners: {
                render: function () {
                    try {
                        var MC = me.getMapContainerClass();
                        me._reportModalMap = new MC('promatic_dashboard_enhancer_report_modal_map');
                        // Sin puntos de entrada, el mapa abre en initCenter
                        // (o en Chile) con zoom de país.
                        var first = mapPoints[0] || (mapOpts && mapOpts.initCenter) || { lat: -33.45, lon: -70.65 };
                        me._reportModalMap.init(first.lat, first.lon, mapPoints.length ? 12 : 5, this.id + '-body', false);
                        for (var i = 0; i < mapPoints.length; i++) {
                            me._drawReportModalMarker(mapPoints[i]);
                        }
                        if (mapPoints.length > 1 && me._reportModalMap.setMapCenter) {
                            me._reportModalMap.setMapCenter(mapPoints.map(function (p) { return [p.lat, p.lon]; }));
                        }
                        Ext.defer(function () {
                            if (me._reportModalMap && me._reportModalMap.checkResize) { me._reportModalMap.checkResize(); }
                        }, 300);
                        Ext.defer(function () {
                            if (me._reportModalMap && me._reportModalMap.checkResize) { me._reportModalMap.checkResize(); }
                        }, 700);
                    } catch (err) {
                        me.widgetErrorCode('REPORTMODAL-MAP-INIT', err);
                        this.body.setHtml(l('No se pudo inicializar el mapa.'));
                    }
                }
            }
        });
    },

    /**
     * Dibuja un marcador del mini-mapa del modal. Registra la coordenada
     * (5 decimales) para no duplicar un punto que ya está dibujado cuando se
     * pide de nuevo desde la tabla.
     */
    _drawReportModalMarker: function (p) {
        var map = this._reportModalMap;
        if (!map || !p || !isFinite(p.lat) || !isFinite(p.lon)) { return; }
        var key = Number(p.lat).toFixed(5) + ',' + Number(p.lon).toFixed(5);
        this._reportModalDrawn = this._reportModalDrawn || {};
        if (this._reportModalDrawn[key]) { return; }
        this._reportModalDrawn[key] = true;
        map.addMarker({
            id: 'promatic_dashboard_enhancer_report_modal_marker_' + key,
            lat: p.lat, lon: p.lon,
            size: 'mini',
            tooltip: p.label ? { msg: p.label, options: { direction: 'top' } } : undefined
        });
    },

    _focusReportModalMapPoint: function (lat, lon, label) {
        var map = this._reportModalMap;
        if (!map || !map.setMapCenter || lat == null || lon == null) { return; }
        try {
            this._drawReportModalMarker({ lat: lat, lon: lon, label: label });
            map.setMapCenter(lat, lon, { zoom: 16 });
        }
        catch (err) { console.warn('[promatic_dashboard_enhancer] focus de punto en mapa del modal falló:', err); }
    },

    /**
     * Resuelve con window.pdfMake. Si no está, intenta cargarlo desde el
     * propio host de PILOT (mismo origen: no viola la regla de no usar CDN).
     * pdfMake necesita pdfmake.min.js + vfs_fonts.js, que PILOT sirve bajo
     * /resources/js/pdfMake/. Cachea la promesa; si no carga en 8 s resuelve
     * con null.
     */
    ensurePdfMake: function () {
        if (window.pdfMake && window.pdfMake.vfs) { return Promise.resolve(window.pdfMake); }
        if (this._pdfMakePromise) { return this._pdfMakePromise; }

        var loadScript = function (src) {
            return new Promise(function (resolve) {
                var s = document.createElement('script');
                s.src = src;
                s.onload = function () { resolve(true); };
                s.onerror = function () { resolve(false); };
                document.head.appendChild(s);
            });
        };

        this._pdfMakePromise = loadScript('/resources/js/pdfMake/pdfmake.min.js')
            .then(function () {
                if (!window.pdfMake) { return null; }
                // vfs_fonts define pdfMake.vfs — si ya vino con el bundle, saltar.
                if (window.pdfMake.vfs) { return window.pdfMake; }
                return loadScript('/resources/js/pdfMake/vfs_fonts.js').then(function () {
                    return (window.pdfMake && window.pdfMake.vfs) ? window.pdfMake : (window.pdfMake || null);
                });
            })
            .catch(function () { return null; });

        // Timeout de seguridad.
        var guarded = Promise.race([
            this._pdfMakePromise,
            new Promise(function (r) { setTimeout(function () { r(window.pdfMake || null); }, 8000); })
        ]);
        return guarded;
    },

    closeReportModal: function () {
        var ov = document.getElementById('promatic_dashboard_enhancer-report-modal');
        if (ov && ov.parentNode) { ov.parentNode.removeChild(ov); }
        if (this._reportModalEsc) {
            document.removeEventListener('keydown', this._reportModalEsc);
            this._reportModalEsc = null;
        }
        if (this._reportModalMsgHandler) {
            window.removeEventListener('message', this._reportModalMsgHandler);
            this._reportModalMsgHandler = null;
        }
        if (this._reportModalMapPanel) {
            try { this._reportModalMapPanel.destroy(); } catch (e) { /* no-op */ }
            this._reportModalMapPanel = null;
        }
        this._reportModalMap = null;
        this._reportModalMapPoints = null;
        this._reportModalDrawn = null;
    },

    // CSS común de los reportes (impresión A4, tabla, cajas de score).
    _reportStyles: function () {
        return '<style>' +
            '*{box-sizing:border-box}' +
            'body{font:13px/1.6 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#1e293b;margin:0;padding:36px 40px;background:#fff}' +
            'h1{font-size:22px;margin:0 0 2px;color:#0a3d5c}' +
            'h2{font-size:14px;margin:26px 0 6px;color:#0a3d5c;border-bottom:2px solid #cbd5e1;padding-bottom:4px;text-transform:uppercase;letter-spacing:.4px}' +
            '.sub{color:#64748b;font-size:11.5px;margin-bottom:4px}' +
            '.lead{color:#334155;font-size:12.5px;margin:2px 0 14px;max-width:52em}' +
            '.desc{color:#475569;font-size:14px;font-style:italic;margin:2px 0 10px;max-width:52em}' +
            'table{border-collapse:collapse;width:100%;margin:8px 0 4px;font-size:11.5px}' +
            'th,td{border:1px solid #e2e8f0;padding:6px 9px;text-align:left}' +
            'th{background:#f1f5f9;font-weight:600;color:#334155}' +
            'tr:nth-child(even) td{background:#fafcfe}' +
            'td.n{text-align:right;font-variant-numeric:tabular-nums}' +
            '.grid{display:flex;gap:10px;flex-wrap:wrap;margin:10px 0}' +
            '.box{flex:1 1 120px;border-radius:8px;padding:12px 14px;color:#fff;min-width:110px}' +
            '.box .v{font-size:27px;font-weight:700;line-height:1}' +
            '.box .l{font-size:10.5px;text-transform:uppercase;letter-spacing:.3px;opacity:.92;margin-top:5px}' +
            '.good{background:#238a4c}.mid{background:#a34d00}.bad{background:#ad1100}.neutral{background:#0a67a0}' +
            '.guide{background:#f8fafc;border:1px solid #e2e8f0;border-left:3px solid #0a67a0;border-radius:6px;padding:12px 16px;margin:10px 0}' +
            '.guide strong{color:#0a3d5c}' +
            '.guide ol{margin:6px 0 0;padding-left:20px}.guide li{margin:4px 0}' +
            '.foot{margin-top:28px;padding-top:10px;border-top:1px solid #e2e8f0;color:#94a3b8;font-size:10.5px}' +
            '.promatic_dashboard_enhancer-focus-btn{font:inherit;color:#0a67a0;background:none;border:0;padding:0;text-decoration:underline;cursor:pointer}' +
            '.promatic_dashboard_enhancer-native-btn{font:inherit;font-size:11px;color:#fff;background:#0a67a0;border:0;border-radius:4px;padding:3px 8px;cursor:pointer}' +
            '@media print{.promatic_dashboard_enhancer-native-btn{display:none}body{padding:14mm}h2{page-break-after:avoid}table,.grid,.guide{page-break-inside:avoid}}' +
            '</style>';
    },

    _widgetDescriptions: {
        flota: 'Distribución de la flota seleccionada por estado operativo en el momento de la consulta: vehículos activos (con señal en las últimas horas), en movimiento, estacionados con motor detenido, y sin conexión al servidor. Se calcula a partir del árbol Online de PILOT, sin generar reportes.',
        gps: 'Vehículos sin comunicación con el servidor, agrupados por el tiempo transcurrido desde su última señal recibida. Sirve para detectar equipos caídos, con problemas de antena, o vehículos guardados hace días. Un vehículo puede estar "sin señal" por batería baja, zona sin cobertura, o manipulación del equipo.',
        alertas: 'Conteo de incidencias por categoría en el período. Accidentes: eventos de colisión detectados por el acelerómetro (últimos 30 días). Ralentí excesivo: vehículos con tiempo de motor encendido detenido sobre el umbral configurado. Requiere mantención: vehículos con inspección o servicio vencido/pendiente según el módulo Técnico-Operacional de PILOT.',
        top5km: 'Ranking de vehículos por kilómetros recorridos en el período. Útil para identificar los vehículos con mayor desgaste, planificar mantenciones por kilometraje, y detectar uso fuera de lo esperado. La distancia se calcula por GPS tramo a tramo (fuente: /api/v3/vehicles/trips).',
        eco: 'Puntaje de conducción segura por vehículo (0-100) del Fleet ECO report de PILOT, que penaliza ralentí excesivo, exceso de velocidad, frenadas y aceleraciones bruscas. Se muestra el rating actual y el del período anterior para ver la tendencia. Un rating negativo indica una cantidad muy alta de infracciones.'
    },

    _reportHeader: function (title, rangeDays) {
        var stop = new Date();
        var start = new Date();
        start.setDate(start.getDate() - (rangeDays || 7));
        var d = function (x) {
            var p = function (n) { return (n < 10 ? '0' : '') + n; };
            return p(x.getDate()) + '/' + p(x.getMonth() + 1) + '/' + x.getFullYear();
        };
        return '<h1>' + title + '</h1><div class="sub">' +
            l('Período') + ': ' + d(start) + ' — ' + d(stop) + ' · ' +
            l('generado') + ' ' + this.chileTime() + '</div>';
    },

    _scoreMod: function (sc) {
        if (sc >= 75) { return 'good'; }
        if (sc >= 45) { return 'mid'; }
        return 'bad';
    },

    /**
     * Formatea un timestamp Unix (segundos) a "dd/mm/aaaa HH:MM" en la zona
     * horaria configurada: el mismo locale/timeZone que el reloj del header
     * (clockConfig).
     */
    _fmtEventDateTime: function (ts) {
        if (ts == null || !isFinite(ts)) { return '—'; }
        var cfg = this.clockConfig();
        try {
            var parts = new Intl.DateTimeFormat(cfg.locale, {
                timeZone: cfg.timeZone,
                day: '2-digit', month: '2-digit', year: 'numeric',
                hour: '2-digit', minute: '2-digit', hour12: false
            }).formatToParts(new Date(ts * 1000));
            var m = {};
            parts.forEach(function (p) { m[p.type] = p.value; });
            return m.day + '/' + m.month + '/' + m.year + ' ' + m.hour + ':' + m.minute;
        } catch (e) {
            return new Date(ts * 1000).toLocaleString();
        }
    },

    /**
     * "yyyy-mm-dd" de un timestamp Unix en la zona horaria configurada, para
     * comparar días de calendario (hoy/ayer vs. histórico) sin arrastrar
     * desfases de huso horario.
     */
    _eventDayKey: function (ts) {
        if (ts == null || !isFinite(ts)) { return null; }
        var cfg = this.clockConfig();
        try {
            var parts = new Intl.DateTimeFormat('en-CA', {
                timeZone: cfg.timeZone, day: '2-digit', month: '2-digit', year: 'numeric'
            }).formatToParts(new Date(ts * 1000));
            var m = {};
            parts.forEach(function (p) { m[p.type] = p.value; });
            return m.year + '-' + m.month + '-' + m.day;
        } catch (e) { return null; }
    },

    /**
     * Link a Google Maps para una coordenada, sin geocoding inverso: la
     * respuesta de events.php type=4911 no trae nombre de calle/ciudad, solo
     * lat/lon.
     */
    _mapsLink: function (lat, lon) {
        if (lat == null || lon == null || !isFinite(lat) || !isFinite(lon)) { return null; }
        return 'https://www.google.com/maps?q=' + encodeURIComponent(lat) + ',' + encodeURIComponent(lon);
    },

    /**
     * Filas de combustible para las tablas de Alertas Generales del
     * exportador (informe del widget y Golden Report): número solo con datos
     * reales, "N/D" si no (sin sensor, sin muestras o formato no
     * reconocido), y la cobertura en la etiqueta.
     */
    _fuelRowsHtml: function () {
        var me = this;
        return [['carga', l('Posibles inconsistencias en carga')], ['drenaje', l('Posible drenaje de combustible')]].map(function (k) {
            var sm = me._fuelSummary(k[0]);
            return '<tr><td>' + k[1] + (sm.cov ? ' <span class="sub">(' + Ext.String.htmlEncode(sm.cov) + ')</span>' : '') +
                '</td><td class="n">' + (typeof sm.count === 'number' ? sm.count : l('N/D')) + '</td></tr>';
        }).join('');
    },

    _fuelRowsPdf: function () {
        var me = this;
        return [['carga', l('Posibles inconsistencias en carga')], ['drenaje', l('Posible drenaje de combustible')]].map(function (k) {
            var sm = me._fuelSummary(k[0]);
            return [k[1] + (sm.cov ? ' (' + sm.cov + ')' : ''),
                { text: typeof sm.count === 'number' ? String(sm.count) : l('N/D'), alignment: 'right' }];
        });
    },

    // Reporte de un widget puntual.
    buildWidgetReport: function (which) {
        var esc = Ext.String.htmlEncode;
        var body = '';
        var title = l('Reporte');
        var days = 7;

        if (which === 'flota') {
            title = l('Estado de Flota');
            var f = this._lastFleetCounts || {};
            body = '<div class="grid">' +
                '<div class="box neutral"><div class="v">' + (f.total || 0) + '</div><div class="l">' + l('Total') + '</div></div>' +
                '<div class="box good"><div class="v">' + (f.moving || 0) + '</div><div class="l">' + l('En movimiento') + '</div></div>' +
                '<div class="box mid"><div class="v">' + (f.parked || 0) + '</div><div class="l">' + l('Estacionado') + '</div></div>' +
                '<div class="box bad"><div class="v">' + (f.offline || 0) + '</div><div class="l">' + l('Sin conexión') + '</div></div>' +
                '</div>';
        } else if (which === 'gps') {
            title = l('Sin Señal GPS');
            var g = this._lastGpsBuckets || {};
            body = '<table><tr><th>' + l('Tiempo sin señal') + '</th><th>' + l('Vehículos') + '</th></tr>' +
                '<tr><td>' + l('Menos de 24h') + '</td><td class="n">' + (g.b24 || 0) + '</td></tr>' +
                '<tr><td>' + l('Entre 24 y 48h') + '</td><td class="n">' + (g.b48 || 0) + '</td></tr>' +
                '<tr><td>' + l('Más de 48h') + '</td><td class="n">' + (g.bMore || 0) + '</td></tr>' +
                '<tr><td>' + l('Sin dato') + '</td><td class="n">' + (g.bNoData || 0) + '</td></tr></table>';
        } else if (which === 'alertas') {
            title = l('Alertas Generales');
            var mk = function (lbl, v) {
                return '<tr><td>' + lbl + '</td><td class="n">' +
                    (typeof v === 'number' ? v : l('N/D')) + '</td></tr>';
            };
            body = '<table><tr><th>' + l('Categoría') + '</th><th>' + l('Incidencias') + '</th></tr>' +
                mk(l('Accidentes'), this._alertAccidentes) +
                mk(l('Requiere mantención'), this._alertMantencion) +
                mk(l('Ralentí excesivo'), this._alertRalenti) +
                this._fuelRowsHtml() +
                (this._alertBorderEnabled ? mk(l('Salida de territorio nacional'), this._alertBorder) : '') +
                '</table><p class="sub">' + (this._alertBorderEnabled
                    ? l('GPS manipulado: en desarrollo, aún sin fuente conectada.')
                    : l('GPS manipulado y territorio nacional: en desarrollo, aún sin fuente conectada.')) + ' ' +
                l('Combustible: posibles cargas y drenajes calculados sobre el sensor; "N/D" indica vehículos sin sensor.') + '</p>';
        } else if (which === 'top5km') {
            title = l('Vehículos con Exceso de Kilometraje');
            var kr = this._lastTop5Ranked || [];
            body = '<table><tr><th>#</th><th>' + l('Vehículo') + '</th><th>' + l('Kilómetros') + '</th></tr>';
            for (var i = 0; i < kr.length; i++) {
                body += '<tr><td>' + (i + 1) + '</td><td>' + esc(this.displayName(kr[i].name)) +
                    '</td><td class="n">' + Math.round(kr[i].km) + ' km</td></tr>';
            }
            body += '</table>';
            if (kr.length === 0) { body = '<p>' + l('Sin datos de kilometraje cargados. Abre el dashboard y espera a que el widget cargue.') + '</p>'; }
        } else if (which === 'eco') {
            title = l('Safety Score (ECO)');
            days = ((this.config && this.config.ecoScore) || this.DEFAULT_CONFIG.ecoScore).windowDays || 8;
            var er = this._lastEcoRows || [];
            if (er.length === 0) {
                body = '<p>' + l('Sin datos del Fleet ECO report cargados.') + '</p>';
            } else {
                var avg = 0;
                for (var e = 0; e < er.length; e++) { avg += er[e].cur; }
                avg = Math.round(avg / er.length);
                body = '<div class="grid"><div class="box ' + this._scoreMod(avg) + '"><div class="v">' + avg +
                    '</div><div class="l">' + l('Score global') + '</div></div></div>';
                var sorted = er.slice().sort(function (a, b) { return b.cur - a.cur; });
                body += '<table><tr><th>' + l('Vehículo') + '</th><th>' + l('Actual') + '</th><th>' + l('Anterior') +
                    '</th><th>' + l('Ralentí') + '</th><th>' + l('Frenadas') + '</th><th>' + l('Aceleradas') +
                    '</th><th>' + l('Distancia') + '</th></tr>';
                var hm = function (s) {
                    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
                    return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m;
                };
                for (var s2 = 0; s2 < sorted.length; s2++) {
                    var r = sorted[s2];
                    body += '<tr><td>' + esc(this.displayName(r.name)) + '</td><td class="n">' + r.cur +
                        '</td><td class="n">' + (isFinite(r.prev) ? r.prev : '—') + '</td><td class="n">' + hm(r.idle) +
                        '</td><td class="n">' + r.brake + '</td><td class="n">' + r.accel +
                        '</td><td class="n">' + Math.round(r.dist) + ' km</td></tr>';
                }
                body += '</table>';
            }
        }

        var desc = this._widgetDescriptions[which];
        if (this._lopIsExport(which)) {
            var lopModel = this._lopExportModel(which);
            title = lopModel.title;
            days = lopModel.days;
            desc = lopModel.desc;
            body = this._lopModelHtml(lopModel);
        }
        var descHtml = desc ? '<p class="desc">' + l(desc) + '</p>' : '';

        return '<!doctype html><html><head><meta charset="utf-8"><title>' + title +
            '</title>' + this._reportStyles() + '</head><body>' +
            this._reportHeader(title, days) + descHtml + body +
            '<div class="foot">' +
            l('Reporte generado por el Dashboard sobre datos de PILOT Telematics. Para ver la información al detalle por evento, revisa el panel Informes de PILOT (ver la guía en el Golden Report).') +
            '</div></body></html>';
    },

    /**
     * Mapa agentid -> record del online_tree en memoria (sin llamadas extra).
     * {} si el árbol aún no cargó.
     */
    _onlineRecordsByAgent: function () {
        var byId = {};
        var tree = this.getOnlineTree();
        if (tree) {
            var recs = tree.getStore().getData().items;
            for (var r = 0; r < recs.length; r++) {
                var aid = recs[r].get('agentid');
                if (aid) { byId[aid] = recs[r]; }
            }
        }
        return byId;
    },

    /**
     * Líneas de texto plano de la ficha de un vehículo del online_tree
     * (modelo y año, VIN, conductor, carpeta). Sin escapar: el llamador
     * escapa para HTML o las usa tal cual en el PDF. [] si no hay record o
     * ningún campo trae valor.
     */
    _vehicleSheetLines: function (rec) {
        if (!rec) { return []; }
        var field = function (k) { var v = rec.get(k); return v ? String(v) : ''; };
        var lines = [];
        var modelYear = [field('model'), field('year')].filter(Boolean).join(' ');
        if (modelYear) { lines.push(modelYear); }
        if (field('vin')) { lines.push('VIN ' + field('vin')); }
        if (field('driver')) { lines.push(l('Conductor') + ': ' + field('driver')); }
        if (field('group')) { lines.push(l('Carpeta') + ': ' + field('group')); }
        return lines;
    },

    /** true si el timestamp Unix cae hoy o ayer (zona horaria configurada). */
    _isTodayOrYesterday: function (ts) {
        var k = this._eventDayKey(ts);
        return k != null && (k === this._eventDayKey(Math.floor(Date.now() / 1000)) ||
            k === this._eventDayKey(Math.floor(Date.now() / 1000) - 86400));
    },

    /**
     * Script del iframe de los modales con filas interactivas: los botones
     * "ver en mapa interno" (data-focus-*) y "abrir informe en PILOT"
     * (data-native-*) avisan al overlay padre por postMessage, porque el
     * iframe no tiene acceso a MapContainer ni a Ext.
     */
    _modalActionsScript: function () {
        return '<script>' +
            'document.addEventListener("click", function (e) {' +
            'var b = e.target.closest(".promatic_dashboard_enhancer-focus-btn");' +
            'if (b) {' +
            'var lat = parseFloat(b.getAttribute("data-focus-lat"));' +
            'var lon = parseFloat(b.getAttribute("data-focus-lon"));' +
            'if (isNaN(lat) || isNaN(lon)) { return; }' +
            'window.parent.postMessage({type: "promatic_dashboard_enhancer_focus_point", lat: lat, lon: lon, label: b.getAttribute("data-focus-label") || ""}, "*");' +
            'return; }' +
            'var n = e.target.closest(".promatic_dashboard_enhancer-native-btn");' +
            'if (!n) { return; }' +
            'window.parent.postMessage({type: "promatic_dashboard_enhancer_open_native_report", reportType: n.getAttribute("data-native-report"), agentId: n.getAttribute("data-native-agent"), ts: n.getAttribute("data-native-ts")}, "*");' +
            '});' +
            '<\/script>';
    },

    /**
     * Cierra el modal y abre el informe nativo de PILOT para un vehículo y el
     * día de un evento. Se ofrece una ventana de dos días (día del evento y el
     * siguiente) porque el informe de accidentes ha mostrado desfases de huso
     * horario del lado de PILOT. Si el tipo de informe no existe en la cuenta,
     * runNativeReport deja solo el vehículo seleccionado en el panel Informes.
     */
    _openNativeReportFromModal: function (reportType, agentId, ts) {
        var me = this;
        if (!reportType || !agentId) { return; }
        var start = isFinite(ts) && ts > 0 ? new Date(ts * 1000) : new Date();
        start.setHours(0, 0, 0, 0);
        var stop = new Date(start.getTime());
        stop.setDate(stop.getDate() + 1);
        me.closeReportModal();
        if (!me.activateReportsTab()) { return; }
        Ext.defer(function () {
            try { me.runNativeReport(reportType, [agentId], start, stop); }
            catch (err) {
                console.warn('[promatic_dashboard_enhancer] informe nativo falló, se marca el vehículo:', err);
                me.selectVehiclesInReports([agentId]);
            }
        }, 200);
    },

    /**
     * Detalle de accidentes reales (events.php type=4911): 1 fila por evento
     * "Real crash detected" en la ventana de loadAlertasGenerales. Sin
     * geocoding inverso (Ubicación muestra lat/lon + link a Google Maps).
     * La ficha del vehículo y su posición actual salen del online_tree en
     * memoria. El informe nativo equivalente es "Crash detection"
     * (report_type=254): cada fila lo abre para ese vehículo y día vía
     * runNativeReport. Ese informe no alimenta el conteo de la tarjeta por su
     * latencia y desfase horario del lado de PILOT.
     *
     * El mini-mapa dibuja solo los accidentes recientes (hoy y ayer, ver
     * _isTodayOrYesterday); los históricos quedan en la tabla y se dibujan al
     * pulsar "ver en mapa interno".
     */
    buildAccidentesReport: function () {
        var me = this;
        var esc = Ext.String.htmlEncode;
        var rows = this._alertAccidentesRows || [];
        var days = 30;
        var title = l('Detalle Alarma de Posibles Accidentes');
        var byId = this._onlineRecordsByAgent();

        var focusBtn = function (lat, lon, text, label) {
            return '<button type="button" class="promatic_dashboard_enhancer-focus-btn" data-focus-lat="' + lat +
                '" data-focus-lon="' + lon + '" data-focus-label="' + esc(label || '') + '">' + text + '</button>';
        };

        var rowHtml = function (r) {
            var rec = r.agentId != null ? byId[r.agentId] : null;
            var cur = rec ? me._recordLatLon(rec) : null;
            var link = me._mapsLink(r.lat, r.lon);
            var label = me.displayName(r.veh) + ' — ' + me._fmtEventDateTime(r.ts);
            var locCell;
            if (r.lat != null && r.lon != null) {
                locCell = r.lat.toFixed(5) + ', ' + r.lon.toFixed(5) +
                    ' — ' + focusBtn(r.lat, r.lon, l('ver en mapa interno'), label) +
                    (link ? ' — <a href="' + esc(link) + '" target="_blank" rel="noopener">' + l('ver en mapa') + ' ↗</a>' : '');
            } else {
                locCell = l('N/D');
            }
            // La posición actual va aparte del punto del choque: un vehículo
            // puede haber seguido operando (o haber sido trasladado) después.
            var curCell = cur
                ? focusBtn(cur[0], cur[1], l('ver posición actual'), me.displayName(r.veh) + ' — ' + l('posición actual')) +
                  '<br>' + cur[0].toFixed(5) + ', ' + cur[1].toFixed(5)
                : l('N/D');
            var sheet = me._vehicleSheetLines(rec).map(esc).join('<br>') || l('N/D');
            var calCell = r.calibrated === false ? l('No') : l('Sí');
            var nativeCell = r.agentId != null
                ? '<button type="button" class="promatic_dashboard_enhancer-native-btn" data-native-report="254" data-native-agent="' +
                  r.agentId + '" data-native-ts="' + (r.ts != null ? r.ts : '') + '">' + l('Abrir informe en PILOT') + '</button>'
                : l('N/D');
            return '<tr><td>' + esc(me._fmtEventDateTime(r.ts)) + '</td><td>' +
                esc(me.displayName(r.veh)) + '</td><td>' + sheet + '</td><td>' + calCell + '</td><td>' +
                locCell + '</td><td>' + curCell + '</td><td>' + nativeCell + '</td></tr>';
        };
        var tableHtml = function (list) {
            var h = '<table id="promatic_dashboard_enhancer-accidentes-table"><tr><th>' + l('Fecha y hora') + '</th><th>' + l('Vehículo') +
                '</th><th>' + l('Ficha') + '</th><th>' + l('Calibrado') + '</th><th>' + l('Ubicación del choque') +
                '</th><th>' + l('Posición actual') + '</th><th>' + l('Informe') + '</th></tr>';
            for (var i = 0; i < list.length; i++) { h += rowHtml(list[i]); }
            return h + '</table>';
        };

        var body;
        if (!rows.length) {
            body = '<p>' + l('Sin accidentes reales detectados en el período.') + '</p>';
        } else {
            // Recientes vs. histórico del resto de la ventana: evita buscar
            // los accidentes más urgentes entre decenas de filas.
            var sorted = rows.slice().sort(function (a, b) { return (b.ts || 0) - (a.ts || 0); });
            var recent = sorted.filter(function (r) { return me._isTodayOrYesterday(r.ts); });
            var historic = sorted.filter(function (r) { return !me._isTodayOrYesterday(r.ts); });
            body = '';
            if (recent.length) {
                body += '<h2>' + l('Recientes (hoy y ayer)') + '</h2>' + tableHtml(recent);
            }
            if (historic.length) {
                body += '<h2>' + l('Histórico del mes') + '</h2>' + tableHtml(historic);
            }
        }

        // La descripción de cara al usuario va separada de la fuente técnica
        // (endpoint/type): la primera es para el usuario final, la segunda es
        // trazabilidad, útil para verificar y fácil de quitar del modal.
        var desc = '<p class="desc">' + l('Alarmas de eventos de posible colisión detectadas por el acelerómetro. Cada fila es una alerta generada de un potencial accidente real, sin agregar ni incluir el ruido de detección repetida. La columna Calibrado indica si el sensor completó su calibración al momento de la detección. "Abrir informe en PILOT" lleva al informe nativo Crash detection de ese vehículo y día. Total: ' + rows.length + '.') + '</p>' +
            '<p class="desc">' + l('Fuente: events.php type=4911') + '</p>';

        return '<!doctype html><html><head><meta charset="utf-8"><title>' + title +
            '</title>' + this._reportStyles() + '</head><body>' +
            this._reportHeader(title, days) + desc + body +
            '<div class="foot">' +
            l('Reporte generado por el Dashboard sobre datos de PILOT Telematics. El informe nativo equivalente es "Crash detection" en el panel Informes de PILOT.') +
            '</div>' + this._modalActionsScript() + '</body></html>';
    },

    /**
     * Puntos y opciones del mini-mapa del modal de accidentes: solo hoy y
     * ayer se dibujan de entrada. El mapa se muestra siempre que haya algún
     * accidente con coordenadas, para poder dibujar los históricos al pulsar
     * "ver en mapa interno".
     * @return {{points: Array, opts: Object}}
     */
    accidentesMapSetup: function () {
        var me = this;
        var withCoords = (this._alertAccidentesRows || []).filter(function (r) { return r.lat != null && r.lon != null; });
        var recent = withCoords.filter(function (r) { return me._isTodayOrYesterday(r.ts); });
        return {
            points: recent.map(function (r) {
                return { lat: r.lat, lon: r.lon, label: me.displayName(r.veh) + ' — ' + me._fmtEventDateTime(r.ts) };
            }),
            opts: {
                showMap: withCoords.length > 0,
                initCenter: withCoords.length ? { lat: withCoords[0].lat, lon: withCoords[0].lon } : null,
                notice: recent.length
                    ? l('Mostrando hoy y ayer')
                    : l('Mostrando hoy y ayer (sin accidentes recientes). Los históricos se dibujan con "ver en mapa interno".')
            }
        };
    },

    /**
     * Detalle de la alerta "Salida de territorio nacional": 1 fila por
     * vehículo con eventos de la notificación de paso fronterizo (los que
     * cuenta la tarjeta). Ficha y posición actual salen del online_tree en
     * memoria (sin llamadas extra); si el vehículo ya no está en el árbol o
     * no tiene posición, solo queda la ubicación del último evento. No hay
     * una función de PILOT conocida para abrir la ficha nativa del vehículo,
     * así que la identificación se hace con los datos de ficha en la tabla.
     */
    buildBorderAlertReport: function () {
        var me = this;
        var esc = Ext.String.htmlEncode;
        var rows = this._alertBorderRows || [];
        var cfg = (this.config && this.config.borderAlert) || this.DEFAULT_CONFIG.borderAlert || {};
        var days = cfg.windowDays || 30;
        var title = l('Detalle Salida de Territorio Nacional');

        var byId = {};
        var tree = this.getOnlineTree();
        if (tree) {
            var recs = tree.getStore().getData().items;
            for (var r = 0; r < recs.length; r++) {
                var aid = recs[r].get('agentid');
                if (aid) { byId[aid] = recs[r]; }
            }
        }

        // Un vehículo detenido repite el aviso: se agrupa y se muestra el
        // último evento con el total.
        var groups = {}, list = [];
        for (var i = 0; i < rows.length; i++) {
            var key = rows[i].agentId != null ? rows[i].agentId : rows[i].veh;
            if (!groups[key]) { groups[key] = { key: key, last: rows[i], count: 0 }; list.push(groups[key]); }
            groups[key].count++;
            if ((rows[i].ts || 0) > (groups[key].last.ts || 0)) { groups[key].last = rows[i]; }
        }
        list.sort(function (a, b) { return (b.last.ts || 0) - (a.last.ts || 0); });

        var focusBtn = function (lat, lon, text) {
            return '<button type="button" class="promatic_dashboard_enhancer-focus-btn" data-focus-lat="' + lat +
                '" data-focus-lon="' + lon + '">' + text + '</button>';
        };
        var mapPoints = [];
        var rowHtml = function (g) {
            var ev = g.last;
            var rec = byId[g.key];
            var cur = rec ? me._recordLatLon(rec) : null;
            var field = function (k) { var v = rec ? rec.get(k) : null; return v ? esc(String(v)) : ''; };

            var specs = [];
            var modelYear = [field('model'), field('year')].filter(Boolean).join(' ');
            if (modelYear) { specs.push(modelYear); }
            if (field('vin')) { specs.push('VIN ' + field('vin')); }
            if (field('driver')) { specs.push(l('Conductor') + ': ' + field('driver')); }
            if (field('group')) { specs.push(l('Carpeta') + ': ' + field('group')); }
            var specCell = specs.length ? specs.join('<br>') : l('N/D');

            var evCell = esc(me._fmtEventDateTime(ev.ts)) +
                (ev.zone ? '<br>' + esc(ev.zone) : '') +
                (g.count > 1 ? '<br>' + g.count + ' ' + l('avisos en el período') : '');

            var posCell = '';
            if (cur) {
                posCell += focusBtn(cur[0], cur[1], l('ver posición actual')) + ' ' +
                    cur[0].toFixed(5) + ', ' + cur[1].toFixed(5);
            }
            if (ev.lat != null && ev.lon != null) {
                posCell += (posCell ? '<br>' : '') + focusBtn(ev.lat, ev.lon, l('ver ubicación del aviso'));
                var link = me._mapsLink(ev.lat, ev.lon);
                if (link) { posCell += ' <a href="' + esc(link) + '" target="_blank" rel="noopener">' + l('ver en mapa') + ' ↗</a>'; }
            }
            if (!posCell) { posCell = l('N/D'); }

            var pt = cur || (ev.lat != null && ev.lon != null ? [ev.lat, ev.lon] : null);
            if (pt) { mapPoints.push({ lat: pt[0], lon: pt[1], label: me.displayName(ev.veh) }); }

            return '<tr><td>' + esc(me.displayName(ev.veh)) + '</td><td>' + specCell + '</td><td>' +
                evCell + '</td><td>' + posCell + '</td></tr>';
        };

        var body;
        if (!list.length) {
            body = '<p>' + l('Sin vehículos detenidos en pasos fronterizos en el período.') + '</p>';
        } else {
            body = '<table id="promatic_dashboard_enhancer-border-table"><tr><th>' + l('Vehículo') + '</th><th>' +
                l('Ficha') + '</th><th>' + l('Último aviso') + '</th><th>' + l('Posición') + '</th></tr>';
            for (var j = 0; j < list.length; j++) { body += rowHtml(list[j]); }
            body += '</table>';
        }
        this._borderModalPoints = mapPoints;

        var desc = '<p class="desc">' + l('Vehículos que se detuvieron en una geocerca de paso fronterizo, según la notificación configurada en PILOT. Un vehículo puede repetir el aviso mientras sigue detenido; se muestra el último. "Posición actual" es la última conocida por PILOT; "ubicación del aviso" es donde ocurrió la detención. Total: ') + list.length + '.</p>' +
            '<p class="desc">' + l('Fuente: events.php type=') + esc(String(cfg.eventType || '')) + '</p>';

        var focusScript =
            '<script>' +
            'document.addEventListener("click", function (e) {' +
            'var b = e.target.closest(".promatic_dashboard_enhancer-focus-btn");' +
            'if (!b) { return; }' +
            'var lat = parseFloat(b.getAttribute("data-focus-lat"));' +
            'var lon = parseFloat(b.getAttribute("data-focus-lon"));' +
            'if (isNaN(lat) || isNaN(lon)) { return; }' +
            'window.parent.postMessage({type: "promatic_dashboard_enhancer_focus_point", lat: lat, lon: lon}, "*");' +
            '});' +
            '<\/script>';

        return '<!doctype html><html><head><meta charset="utf-8"><title>' + title +
            '</title>' + this._reportStyles() + '</head><body>' +
            this._reportHeader(title, days) + desc + body +
            '<div class="foot">' +
            l('Reporte generado por el Dashboard sobre datos de PILOT Telematics.') +
            '</div>' + focusScript + '</body></html>';
    },

    buildGoldenReport: function () {
        var esc = Ext.String.htmlEncode;
        var f = this._lastFleetCounts || {};
        var g = this._lastGpsBuckets || {};
        var er = this._lastEcoRows || [];
        var kr = this._lastTop5Ranked || [];

        var ecoAvg = 0;
        if (er.length) { for (var i = 0; i < er.length; i++) { ecoAvg += er[i].cur; } ecoAvg = Math.round(ecoAvg / er.length); }

        var s = '<!doctype html><html><head><meta charset="utf-8"><title>Golden Report</title>' +
            this._reportStyles() + '</head><body>' +
            this._reportHeader('Golden Report — ' + l('Resumen semanal de flota'), 7);

        s += '<p class="lead">' + l('Este documento resume el estado de la flota de la última semana en una sola vista: disponibilidad operativa, conectividad, alertas, kilometraje y conducción segura. Al final incluye una guía para ver la información al detalle desde los paneles de PILOT.') + '</p>';

        // Resumen ejecutivo en cajas
        s += '<h2>' + l('Resumen') + '</h2>' +
            '<p class="desc">' + l('Fotografía de la flota en el momento de generar el reporte.') + '</p>' +
            '<div class="grid">' +
            '<div class="box neutral"><div class="v">' + (f.total || 0) + '</div><div class="l">' + l('Vehículos') + '</div></div>' +
            '<div class="box good"><div class="v">' + (f.moving || 0) + '</div><div class="l">' + l('En movimiento') + '</div></div>' +
            '<div class="box bad"><div class="v">' + (f.offline || 0) + '</div><div class="l">' + l('Sin conexión') + '</div></div>' +
            (er.length ? '<div class="box ' + this._scoreMod(ecoAvg) + '"><div class="v">' + ecoAvg + '</div><div class="l">' + l('Safety Score') + '</div></div>' : '') +
            '</div>';

        // Sin Señal GPS
        s += '<h2>' + l('Sin Señal GPS') + '</h2><table>' +
            '<tr><th>' + l('Menos de 24h') + '</th><th>' + l('Entre 24 y 48h') + '</th><th>' + l('Más de 48h') + '</th><th>' + l('Sin dato') + '</th></tr>' +
            '<tr><td class="n">' + (g.b24 || 0) + '</td><td class="n">' + (g.b48 || 0) + '</td><td class="n">' + (g.bMore || 0) + '</td><td class="n">' + (g.bNoData || 0) + '</td></tr></table>';

        // Alertas
        s += '<h2>' + l('Alertas Generales') + '</h2><table><tr><th>' + l('Categoría') + '</th><th>' + l('Incidencias') + '</th></tr>';
        var row = function (lbl, v) { return '<tr><td>' + lbl + '</td><td class="n">' + (typeof v === 'number' ? v : l('N/D')) + '</td></tr>'; };
        s += row(l('Accidentes'), this._alertAccidentes) + row(l('Requiere mantención'), this._alertMantencion) +
            row(l('Ralentí excesivo'), this._alertRalenti) + this._fuelRowsHtml() + '</table>';

        // Top KM
        if (kr.length) {
            s += '<h2>' + l('Vehículos con Exceso de Kilometraje') + '</h2><table><tr><th>#</th><th>' +
                l('Vehículo') + '</th><th>' + l('Kilómetros') + '</th></tr>';
            for (var k = 0; k < Math.min(kr.length, 10); k++) {
                s += '<tr><td>' + (k + 1) + '</td><td>' + esc(this.displayName(kr[k].name)) + '</td><td class="n">' + Math.round(kr[k].km) + ' km</td></tr>';
            }
            s += '</table>';
        }

        // Safety Score detalle
        if (er.length) {
            var sorted = er.slice().sort(function (a, b) { return b.cur - a.cur; });
            s += '<h2>' + l('Safety Score — ranking') + '</h2><table><tr><th>' + l('Vehículo') + '</th><th>' +
                l('Actual') + '</th><th>' + l('Anterior') + '</th></tr>';
            for (var e2 = 0; e2 < sorted.length; e2++) {
                s += '<tr><td>' + esc(this.displayName(sorted[e2].name)) + '</td><td class="n">' + sorted[e2].cur +
                    '</td><td class="n">' + (isFinite(sorted[e2].prev) ? sorted[e2].prev : '—') + '</td></tr>';
            }
            s += '</table>';
        }

        s += this._lopGoldenHtml();

        // Guía para el Excel de PILOT
        s += '<h2>' + l('Para ver la información al detalle en PILOT') + '</h2>' +
            '<div class="guide"><strong>' + l('Informe de Kilometraje') + '</strong><ol>' +
            '<li>' + l('En PILOT, abre el panel lateral') + ' <em>' + l('Informes') + '</em>.</li>' +
            '<li>' + l('Selecciona los vehículos o la carpeta en el árbol de objetos.') + '</li>' +
            '<li>' + l('Tipo de informe') + ': <em>' + l('Informe de kilometraje') + '</em>. ' +
            l('Rango: última semana. División: "No dividir".') + '</li>' +
            '<li>' + l('Genera y usa el botón de exportar a Excel de la barra del informe.') + '</li></ol></div>' +
            '<div class="guide"><strong>Fleet ECO report (Safety Score)</strong><ol>' +
            '<li>' + l('Panel') + ' <em>' + l('Informes') + '</em> → ' + l('tipo') + ' <em>Fleet ECO report</em>.</li>' +
            '<li>' + l('Selecciona el grupo/carpeta de vehículos y el rango semanal.') + '</li>' +
            '<li>' + l('Genera; la tabla trae Ralentí, Exceso de velocidad, Frenadas/Aceleradas bruscas, Distancia, Duración y Rating actual/anterior por vehículo.') + '</li>' +
            '<li>' + l('Exporta a Excel desde la barra del informe.') + '</li></ol></div>' +
            '<div class="guide"><strong>' + l('Alertas / eventos') + '</strong><ol>' +
            '<li>' + l('Panel') + ' <em>' + l('Mensajes') + '</em> o <em>' + l('Eventos') + '</em> ' +
            l('para el detalle por evento (desconexión, ralentí, conducción brusca), filtrando por tipo y rango.') + '</li></ol></div>';

        s += '<div class="foot">' +
            l('Golden Report generado por el Dashboard sobre datos de PILOT Telematics. Los valores corresponden a la selección de vehículos activa y a la ventana de la última semana.') +
            '</div></body></html>';
        return s;
    },

    _pdfBase: function (title, subtitle) {
        return {
            pageSize: 'A4',
            pageMargins: [40, 48, 40, 48],
            defaultStyle: { fontSize: 9, color: '#1e293b' },
            styles: {
                h1: { fontSize: 16, bold: true, color: '#0a3d5c', margin: [0, 0, 0, 2] },
                h2: { fontSize: 11, bold: true, color: '#0a3d5c', margin: [0, 14, 0, 4] },
                sub: { fontSize: 8, color: '#64748b', margin: [0, 0, 0, 2] },
                desc: { fontSize: 8, italics: true, color: '#475569', margin: [0, 2, 0, 8] },
                th: { bold: true, fillColor: '#f1f5f9', color: '#334155' },
                foot: { fontSize: 7.5, color: '#94a3b8', margin: [0, 20, 0, 0] }
            },
            content: [
                { text: title, style: 'h1' },
                { text: subtitle, style: 'sub' }
            ]
        };
    },
    _pdfRange: function (days) {
        var stop = new Date(), start = new Date();
        start.setDate(start.getDate() - (days || 7));
        var d = function (x) {
            var p = function (n) { return (n < 10 ? '0' : '') + n; };
            return p(x.getDate()) + '/' + p(x.getMonth() + 1) + '/' + x.getFullYear();
        };
        return l('Período') + ': ' + d(start) + ' — ' + d(stop) + '  ·  ' + l('generado') + ' ' + this.chileTime();
    },
    _pdfScoreColor: function (sc) {
        return sc >= 75 ? '#238a4c' : (sc >= 45 ? '#a34d00' : '#ad1100');
    },
    // tabla simple: headers = [str], rows = [[cell,...]]
    _pdfTable: function (headers, rows) {
        var body = [headers.map(function (h) { return { text: h, style: 'th' }; })];
        for (var i = 0; i < rows.length; i++) { body.push(rows[i]); }
        return {
            table: { headerRows: 1, widths: headers.map(function () { return '*'; }), body: body },
            layout: { hLineColor: function () { return '#e2e8f0'; }, vLineColor: function () { return '#e2e8f0'; } },
            margin: [0, 4, 0, 4]
        };
    },
    /**
     * pdfMake solo pinta fondo con fillColor en celdas de TABLA (no en
     * columns/stack sueltos). Las cajas de score van como una tabla de 1
     * fila, una celda por caja, con el color como fillColor de la celda.
     */
    _pdfBoxes: function (items) {
        var row = items.map(function (it) {
            return {
                fillColor: it.color,
                margin: [6, 8, 6, 8],
                stack: [
                    { text: String(it.v), fontSize: 20, bold: true, color: '#ffffff' },
                    { text: it.l, fontSize: 7, color: '#ffffff', characterSpacing: 0.3, margin: [0, 3, 0, 0] }
                ]
            };
        });
        return {
            table: {
                widths: items.map(function () { return '*'; }),
                body: [row]
            },
            // Sin líneas de tabla — solo los rellenos.
            layout: {
                hLineWidth: function () { return 0; },
                vLineWidth: function () { return 6; },
                vLineColor: function () { return '#ffffff'; },
                paddingLeft: function () { return 0; },
                paddingRight: function () { return 0; }
            },
            margin: [0, 4, 0, 8]
        };
    },

    buildWidgetPdfDoc: function (which) {
        var lopModel = this._lopIsExport(which) ? this._lopExportModel(which) : null;
        var doc = this._pdfBase(this._widgetReportName(which),
            this._pdfRange(lopModel ? lopModel.days : (which === 'eco' ? (((this.config && this.config.ecoScore) || this.DEFAULT_CONFIG.ecoScore).windowDays || 8) : 7)));
        var desc = lopModel ? lopModel.desc : this._widgetDescriptions[which];
        if (desc) { doc.content.push({ text: l(desc), style: 'desc' }); }
        var C = doc.content;
        var name = this.displayName.bind(this);

        if (which === 'flota') {
            var f = this._lastFleetCounts || {};
            C.push(this._pdfBoxes([
                { v: f.total || 0, l: l('Total'), color: '#0a67a0' },
                { v: f.moving || 0, l: l('En movimiento'), color: '#238a4c' },
                { v: f.parked || 0, l: l('Estacionado'), color: '#a34d00' },
                { v: f.offline || 0, l: l('Sin conexión'), color: '#ad1100' }
            ]));
        } else if (which === 'gps') {
            var g = this._lastGpsBuckets || {};
            C.push(this._pdfTable([l('Tiempo sin señal'), l('Vehículos')], [
                [l('Menos de 24h'), { text: String(g.b24 || 0), alignment: 'right' }],
                [l('Entre 24 y 48h'), { text: String(g.b48 || 0), alignment: 'right' }],
                [l('Más de 48h'), { text: String(g.bMore || 0), alignment: 'right' }]
            ]));
        } else if (which === 'alertas') {
            var v = function (x) { return typeof x === 'number' ? String(x) : l('N/D'); };
            C.push(this._pdfTable([l('Categoría'), l('Incidencias')], [
                [l('Accidentes'), { text: v(this._alertAccidentes), alignment: 'right' }],
                [l('Requiere mantención'), { text: v(this._alertMantencion), alignment: 'right' }],
                [l('Ralentí excesivo'), { text: v(this._alertRalenti), alignment: 'right' }]
            ].concat(this._fuelRowsPdf())));
        } else if (which === 'top5km') {
            var kr = this._lastTop5Ranked || [];
            C.push(this._pdfTable(['#', l('Vehículo'), l('Kilómetros')],
                kr.map(function (r, i) {
                    return [String(i + 1), name(r.name), { text: Math.round(r.km) + ' km', alignment: 'right' }];
                })));
            if (!kr.length) { C.push({ text: l('Sin datos de kilometraje cargados.') }); }
        } else if (which === 'eco') {
            var er = this._lastEcoRows || [];
            if (!er.length) { C.push({ text: l('Sin datos del Fleet ECO report cargados.') }); }
            else {
                var avg = 0; for (var e = 0; e < er.length; e++) { avg += er[e].cur; } avg = Math.round(avg / er.length);
                C.push(this._pdfBoxes([{ v: avg, l: l('Score global'), color: this._pdfScoreColor(avg) }]));
                var hm = function (s) { var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60); return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m; };
                var sorted = er.slice().sort(function (a, b) { return b.cur - a.cur; });
                C.push(this._pdfTable([l('Vehículo'), l('Actual'), l('Anterior'), l('Ralentí'), l('Frenadas'), l('Aceleradas'), l('Distancia')],
                    sorted.map(function (r) {
                        return [name(r.name),
                            { text: String(r.cur), alignment: 'right' },
                            { text: isFinite(r.prev) ? String(r.prev) : '—', alignment: 'right' },
                            { text: hm(r.idle), alignment: 'right' },
                            { text: String(r.brake), alignment: 'right' },
                            { text: String(r.accel), alignment: 'right' },
                            { text: Math.round(r.dist) + ' km', alignment: 'right' }];
                    })));
            }
        }
        if (lopModel) { this._lopPdfContent(lopModel, C); }
        C.push({ text: l('Reporte generado por el Dashboard sobre datos de PILOT Telematics.'), style: 'foot' });
        return doc;
    },

    buildAccidentesPdfDoc: function () {
        var doc = this._pdfBase(l('Detalle Alarma de Posibles Accidentes'), this._pdfRange(30));
        var rows = this._alertAccidentesRows || [];
        var name = this.displayName.bind(this);
        var C = doc.content;
        C.push({ text: l('Eventos de colisión detectados por el acelerómetro del dispositivo ("Real crash detected"), fuente events.php type=4911.'), style: 'desc' });

        if (!rows.length) {
            C.push({ text: l('Sin accidentes reales detectados en el período.') });
        } else {
            var sorted = rows.slice().sort(function (a, b) { return (b.ts || 0) - (a.ts || 0); });
            var me = this;
            var byId = this._onlineRecordsByAgent();
            C.push(this._pdfTable([l('Fecha y hora'), l('Vehículo'), l('Ficha'), l('Calibrado'), l('Ubicación del choque'), l('Posición actual')],
                sorted.map(function (r) {
                    var rec = r.agentId != null ? byId[r.agentId] : null;
                    var cur = rec ? me._recordLatLon(rec) : null;
                    var loc = (r.lat != null && r.lon != null) ? (r.lat.toFixed(5) + ', ' + r.lon.toFixed(5)) : l('N/D');
                    var cal = r.calibrated === false ? l('No') : l('Sí');
                    var sheet = me._vehicleSheetLines(rec).join('\n') || l('N/D');
                    return [me._fmtEventDateTime(r.ts), name(r.veh), sheet, cal, loc,
                        cur ? (cur[0].toFixed(5) + ', ' + cur[1].toFixed(5)) : l('N/D')];
                })));
        }
        C.push({ text: l('Reporte generado por el Dashboard sobre datos de PILOT Telematics. El informe nativo equivalente es "Crash detection" en el panel Informes de PILOT.'), style: 'foot' });
        return doc;
    },

    // Metadata de los buckets de "Sin Señal GPS". Clave compartida por
    // buildGpsSignalReport, buildGpsSignalPdfDoc y el click handler de los
    // chips (bindAlertReportLinks).
    _GPS_BUCKET_META: {
        '24': { rowsKey: 'rows24', title: l('Sin señal — menos de 24h') },
        '48': { rowsKey: 'rows48', title: l('Sin señal — entre 24 y 48h') },
        'more': { rowsKey: 'rowsMore', title: l('Sin señal — más de 48h') },
        'nodata': { rowsKey: 'rowsNoData', title: l('Sin señal — sin dato de última conexión') }
    },

    /**
     * Modal de detalle al hacer click en un chip de "Sin Señal GPS". Mismo
     * patrón que buildAccidentesReport (tabla + mini-mapa vía
     * openReportModal), sin columna Calibrado (no aplica) ni secciones
     * Recientes/Histórico (todas las filas son "sin señal ahora mismo").
     */
    buildGpsSignalReport: function (bucket) {
        var me = this;
        var esc = Ext.String.htmlEncode;
        var meta = this._GPS_BUCKET_META[bucket] || this._GPS_BUCKET_META['24'];
        var rows = (this._lastGpsBuckets && this._lastGpsBuckets[meta.rowsKey]) || [];
        var title = meta.title;

        var rowHtml = function (r) {
            var link = me._mapsLink(r.lat, r.lon);
            var locCell;
            if (r.lat != null && r.lon != null) {
                locCell = '<button type="button" class="promatic_dashboard_enhancer-focus-btn" data-focus-lat="' + r.lat + '" data-focus-lon="' + r.lon + '">' + l('ver en mapa interno') + '</button>' +
                    (link ? ' — <a href="' + esc(link) + '" target="_blank" rel="noopener">' + l('ver en mapa') + ' ↗</a>' : '') +
                    ' — ' + r.lat.toFixed(5) + ', ' + r.lon.toFixed(5);
            } else {
                locCell = l('N/D');
            }
            var tsCell = r.ts != null ? esc(me._fmtEventDateTime(r.ts)) : l('N/D');
            return '<tr><td>' + tsCell + '</td><td>' + esc(me.displayName(r.veh)) + '</td><td>' + locCell + '</td></tr>';
        };

        var body;
        if (!rows.length) {
            body = '<p>' + l('Ningún vehículo en este rango.') + '</p>';
        } else {
            var sorted = rows.slice().sort(function (a, b) { return (a.ts || 0) - (b.ts || 0); });
            body = '<table id="promatic_dashboard_enhancer-gps-signal-table"><tr><th>' + l('Última señal') + '</th><th>' + l('Vehículo') +
                '</th><th>' + l('Ubicación') + '</th></tr>';
            for (var i = 0; i < sorted.length; i++) { body += rowHtml(sorted[i]); }
            body += '</table>';
        }

        var desc = '<p class="desc">' + l('Última posición conocida antes de perder señal — mientras el vehículo está desconectado no hay una ubicación "actual" distinta de esta. Total: ' + rows.length + '.') + '</p>';

        var focusScript =
            '<script>' +
            'document.addEventListener("click", function (e) {' +
            'var b = e.target.closest(".promatic_dashboard_enhancer-focus-btn");' +
            'if (!b) { return; }' +
            'var lat = parseFloat(b.getAttribute("data-focus-lat"));' +
            'var lon = parseFloat(b.getAttribute("data-focus-lon"));' +
            'if (isNaN(lat) || isNaN(lon)) { return; }' +
            'window.parent.postMessage({type: "promatic_dashboard_enhancer_focus_point", lat: lat, lon: lon}, "*");' +
            '});' +
            '<\/script>';

        var header = '<h1>' + esc(title) + '</h1><div class="sub">' +
            l('Estado') + ': ' + l('ahora mismo') + ' · ' + l('generado') + ' ' + this.chileTime() + '</div>';

        return '<!doctype html><html><head><meta charset="utf-8"><title>' + title +
            '</title>' + this._reportStyles() + '</head><body>' +
            header + desc + body +
            '<div class="foot">' +
            l('Reporte generado por el Dashboard sobre datos de PILOT Telematics.') +
            '</div>' + focusScript + '</body></html>';
    },

    buildGpsSignalPdfDoc: function (bucket) {
        var meta = this._GPS_BUCKET_META[bucket] || this._GPS_BUCKET_META['24'];
        var rows = (this._lastGpsBuckets && this._lastGpsBuckets[meta.rowsKey]) || [];
        var doc = this._pdfBase(meta.title, l('Estado: ahora mismo') + ' · ' + this.chileTime());
        var name = this.displayName.bind(this);
        var me = this;
        var C = doc.content;
        C.push({ text: l('Última posición conocida antes de perder señal.'), style: 'desc' });

        if (!rows.length) {
            C.push({ text: l('Ningún vehículo en este rango.') });
        } else {
            var sorted = rows.slice().sort(function (a, b) { return (a.ts || 0) - (b.ts || 0); });
            C.push(this._pdfTable([l('Última señal'), l('Vehículo'), l('Ubicación')],
                sorted.map(function (r) {
                    var loc = (r.lat != null && r.lon != null) ? (r.lat.toFixed(5) + ', ' + r.lon.toFixed(5)) : l('N/D');
                    var ts = r.ts != null ? me._fmtEventDateTime(r.ts) : l('N/D');
                    return [ts, name(r.veh), loc];
                })));
        }
        C.push({ text: l('Reporte generado por el Dashboard sobre datos de PILOT Telematics.'), style: 'foot' });
        return doc;
    },

    buildGoldenPdfDoc: function () {
        var doc = this._pdfBase('Golden Report — ' + l('Resumen semanal de flota'), this._pdfRange(7));
        var C = doc.content;
        var name = this.displayName.bind(this);
        var f = this._lastFleetCounts || {}, g = this._lastGpsBuckets || {};
        var er = this._lastEcoRows || [], kr = this._lastTop5Ranked || [];
        var ecoAvg = 0; if (er.length) { for (var i = 0; i < er.length; i++) { ecoAvg += er[i].cur; } ecoAvg = Math.round(ecoAvg / er.length); }

        C.push({ text: l('Este documento resume el estado de la flota de la última semana: disponibilidad, conectividad, alertas, kilometraje y conducción segura.'), style: 'desc' });

        C.push({ text: l('Resumen'), style: 'h2' });
        var boxes = [
            { v: f.total || 0, l: l('Vehículos'), color: '#0a67a0' },
            { v: f.moving || 0, l: l('En movimiento'), color: '#238a4c' },
            { v: f.offline || 0, l: l('Sin conexión'), color: '#ad1100' }
        ];
        if (er.length) { boxes.push({ v: ecoAvg, l: l('Safety Score'), color: this._pdfScoreColor(ecoAvg) }); }
        C.push(this._pdfBoxes(boxes));

        C.push({ text: l('Sin Señal GPS'), style: 'h2' });
        C.push(this._pdfTable([l('Menos de 24h'), l('Entre 24 y 48h'), l('Más de 48h'), l('Sin dato')],
            [[{ text: String(g.b24 || 0), alignment: 'right' }, { text: String(g.b48 || 0), alignment: 'right' }, { text: String(g.bMore || 0), alignment: 'right' }, { text: String(g.bNoData || 0), alignment: 'right' }]]));

        C.push({ text: l('Alertas Generales'), style: 'h2' });
        var av = function (x) { return typeof x === 'number' ? String(x) : l('N/D'); };
        C.push(this._pdfTable([l('Categoría'), l('Incidencias')], [
            [l('Accidentes'), { text: av(this._alertAccidentes), alignment: 'right' }],
            [l('Requiere mantención'), { text: av(this._alertMantencion), alignment: 'right' }],
            [l('Ralentí excesivo'), { text: av(this._alertRalenti), alignment: 'right' }]
        ]));

        if (kr.length) {
            C.push({ text: l('Vehículos con Exceso de Kilometraje'), style: 'h2' });
            C.push(this._pdfTable(['#', l('Vehículo'), l('Kilómetros')],
                kr.slice(0, 10).map(function (r, i) { return [String(i + 1), name(r.name), { text: Math.round(r.km) + ' km', alignment: 'right' }]; })));
        }
        if (er.length) {
            C.push({ text: l('Safety Score — ranking'), style: 'h2' });
            var sorted = er.slice().sort(function (a, b) { return b.cur - a.cur; });
            C.push(this._pdfTable([l('Vehículo'), l('Actual'), l('Anterior')],
                sorted.map(function (r) { return [name(r.name), { text: String(r.cur), alignment: 'right' }, { text: isFinite(r.prev) ? String(r.prev) : '—', alignment: 'right' }]; })));
        }

        this._lopGoldenPdf(C);

        C.push({ text: l('Para ver la información al detalle en PILOT'), style: 'h2' });
        C.push({ ul: [
            l('Kilometraje: panel Informes → "Informe de kilometraje", selecciona vehículos/carpeta y el rango semanal, exporta a Excel.'),
            l('Safety Score: panel Informes → "Fleet ECO report", selecciona el grupo y el rango, exporta a Excel.'),
            l('Accidentes y eventos: panel Mensajes / Eventos, filtra por tipo y rango para el detalle por evento (fecha, hora, posición).')
        ], fontSize: 8.5, margin: [0, 4, 0, 0] });

        C.push({ text: l('Golden Report generado por el Dashboard sobre datos de PILOT Telematics.'), style: 'foot' });
        return doc;
    },

    /**
     * Layout de 4 columnas: izquierda fija (Alertas Generales), centro
     * angosto (Sin Señal GPS + Top KM apiladas), mapas (ubicación y hotspots,
     * doble de ancho) y derecha fija (logo, hora, exportar). En ancho angosto
     * la columna derecha pasa a barra horizontal arriba: grid-template-areas
     * cambia solo la DISPOSICIÓN con el mismo DOM (ver .shell-grid en
     * style.css).
     *
     * Un solo DOM sirve a las dos vistas (RAC y LOP): cada card declara en
     * VIEW_WIDGETS en qué vista se muestra y el CSS oculta la otra según la
     * clase de vista del panel raíz. Así el cambio de vista es en vivo, sin
     * destruir mapas ni volver a montar listeners. Las cards exclusivas de LOP
     * que aún no existen son placeholders (ver lopSlotCards).
     *
     * El buscador de reportes está oculto: cardMarkup('buscador') se conserva
     * pero no se monta. buildLopShell se mantiene como rollback de la vista
     * anterior.
     */
    buildRacShell: function () {
        var colLeft = {
            cls: 'promatic_dashboard_enhancer-area-alertas',
            cn: [
                this.cardMarkup('alertas_generales', {
                    title: l('Alertas Generales'),
                    hint: l('Accidentes: eventos de los últimos 30 días. Requiere mantención: recordatorios por vehículo configurados en PILOT. Las categorías "beta" aún no están conectadas. Cada tarjeta con incidencias abre el informe correspondiente en PILOT.'),
                    noFooter: true,
                    skeleton: 'stats'
                })
            ]
        };

        var colMid = {
            cls: 'promatic_dashboard_enhancer-area-mid',
            cn: [
                this.cardMarkup('gps_signal', {
                    title: l('Sin Señal GPS'),
                    hint: l('Vehículos sin conexión al servidor, agrupados por el tiempo desde su última señal recibida. Se actualiza en vivo con el árbol Online.'),
                    noFooter: true,
                    skeleton: 'chips'
                }),
                this.cardMarkup('top5km', {
                    title: l('Vehículos con Exceso de Kilometraje'),
                    hint: l('Kilómetros por vehículo en el período configurado (por defecto 7 días). Fuente: /api/v3/vehicles/trips, con respaldo al reporte de kilometraje.'),
                    footerLabel: l('Abrir reporte de kilometraje'),
                    skeleton: 'ranking'
                }),
                this.cardMarkup('flota', {
                    title: l('Estado de Flota'),
                    hint: l('Vehículos seleccionados en el panel "Principal": activos, en movimiento, estacionados y sin conexión. Se actualiza en vivo con el árbol Online.'),
                    noFooter: true,
                    skeleton: 'donut'
                }),
                this.cardMarkup('violations', {
                    title: l('Tendencia de Infracciones de Manejo'),
                    hint: l('Infracciones de manejo por categoría (velocidad, aceleración, frenado, ralentí, giro, cinturón) sumadas en la ventana configurada. Fuente: reports.php report_type=114.'),
                    noFooter: true,
                    skeleton: 'stats'
                })
            ].concat(this.lopSlotCards('mid'))
        };

        var colMap = {
            cls: 'promatic_dashboard_enhancer-area-map',
            cn: [
                // Safety Score va arriba del mapa para que el dato más
                // importante de la columna no quede relegado.
                this.cardMarkup('eco_score', {
                    title: l('Safety Score (ECO)'),
                    hint: l('Puntaje de conducción segura por evento de manejo brusco (frenadas/aceleraciones/curvas bruscas, idling), normalizado por km. 100 = sin eventos. Fuente: events.php type=24, ventana configurable.'),
                    noFooter: true,
                    skeleton: 'donut'
                }),
                // Orden: el mapa de ubicación actual arriba y el de hotspots
                // abajo, porque el primero se consulta con más frecuencia que
                // el histórico de cortes.
                this.cardMarkup('fleet_map', {
                    title: l('Ubicación Global de la Flota'),
                    hint: l('Última posición conocida de cada vehículo, agrupada en clusters cuando hay varios cerca. Click en un vehículo o en un cluster para ver el detalle. El menú de arriba filtra por carpeta del panel "Principal".'),
                    noFooter: true,
                    skeleton: 'map',
                    headExtra: {
                        tag: 'select',
                        id: 'promatic_dashboard_enhancer-fleetmap-folder',
                        cls: 'promatic_dashboard_enhancer-map-folder',
                        cn: [{ tag: 'option', value: '__all__', html: l('Ver todos los seleccionados') }]
                    }
                }),
                this.cardMarkup('hotspots', {
                    title: l('Hotspots de Pérdida de Conexión'),
                    hint: l('Puntos de calor con el historial de cortes de señal GPS (últimos 30 días) — dónde tiende a perderse la conexión con más frecuencia. "Cortes largos" son vehículos apagados/fuera de cobertura por mucho tiempo; "Intermitencias breves" son cortes cortos típicos de túneles y pasos subterráneos. El menú de carpeta filtra por selección del panel "Principal".'),
                    noFooter: true,
                    skeleton: 'map',
                    headExtra: {
                        cls: 'promatic_dashboard_enhancer-map-controls',
                        cn: [
                            {
                                tag: 'select',
                                id: 'promatic_dashboard_enhancer-hotspots-gap-mode',
                                cls: 'promatic_dashboard_enhancer-map-folder',
                                cn: [
                                    { tag: 'option', value: 'long', html: l('Cortes largos') },
                                    { tag: 'option', value: 'short', html: l('Intermitencias breves') }
                                ]
                            },
                            {
                                tag: 'select',
                                id: 'promatic_dashboard_enhancer-map-folder',
                                cls: 'promatic_dashboard_enhancer-map-folder',
                                cn: [{ tag: 'option', value: '__all__', html: l('Ver todos los seleccionados') }]
                            }
                        ]
                    }
                })
            ].concat(this.lopSlotCards('map'))
        };

        var colRight = {
            cls: 'promatic_dashboard_enhancer-area-topbar',
            cn: [
                this.cardMarkup('logo', { noFooter: true }),
                this.cardMarkup('reloj', { title: l('Hora Oficial'), noFooter: true }),
                this.exportBlockMarkup()
            ]
        };

        var shell = [
            {
                cls: 'promatic_dashboard_enhancer-shell-grid',
                cn: [
                    colRight,
                    { cls: 'promatic_dashboard_enhancer-shell-row', cn: [colLeft, colMid, colMap] }
                ]
            },
            // Contenedor reservado sobre el footer de controles para widgets
            // horizontales sueltos; hoy queda vacío/oculto.
            { id: 'promatic_dashboard_enhancer-eco-folder-bar', cls: 'promatic_dashboard_enhancer-eco-folder-bar', cn: [] },
            this.controlsBarMarkup()
        ];

        return Ext.create('Ext.Component', {
            cls: 'promatic_dashboard_enhancer-rac-shell',
            html: Ext.DomHelper.markup(shell)
        });
    },

    /**
     * Barra de controles del pie:
     * - Actualizar widgets: re-dispara todos los widgets sin recargar y sella
     *   la hora en la barra de resumen.
     */
    controlsBarMarkup: function () {
        return {
            cls: 'promatic_dashboard_enhancer-controls',
            cn: [
                {
                    tag: 'button', type: 'button',
                    id: 'promatic_dashboard_enhancer-btn-refresh',
                    cls: 'promatic_dashboard_enhancer-ctrl-btn promatic_dashboard_enhancer-ctrl-btn--primary',
                    html: l('Actualizar widgets')
                },
                this.scaleControlMarkup()
            ]
        };
    },

    /**
     * Control de escala +/-. Cambia --scale-factor en el panel raíz, que
     * mueve el font-size REAL del contenedor: todo lo escrito en `em` en
     * style.css escala de verdad y Ext mide el DOM real. No usar CSS
     * `zoom`/`transform`: rompe el área clickeable de Ext JS. Paso 5%, rango
     * 80%-130%, persistido por equipo/navegador (el problema es el monitor,
     * no la cuenta de PILOT).
     */
    scaleControlMarkup: function () {
        var pct = this.getScalePct();
        return {
            id: 'promatic_dashboard_enhancer-scale-ctrl',
            cls: 'promatic_dashboard_enhancer-scale',
            cn: [
                {
                    tag: 'button', type: 'button',
                    id: 'promatic_dashboard_enhancer-scale-minus',
                    cls: 'promatic_dashboard_enhancer-scale__btn',
                    'aria-label': l('Achicar dashboard'),
                    html: '−'
                },
                {
                    tag: 'span',
                    id: 'promatic_dashboard_enhancer-scale-pct',
                    cls: 'promatic_dashboard_enhancer-scale__pct',
                    html: pct + '%'
                },
                {
                    tag: 'button', type: 'button',
                    id: 'promatic_dashboard_enhancer-scale-plus',
                    cls: 'promatic_dashboard_enhancer-scale__btn',
                    'aria-label': l('Agrandar dashboard'),
                    html: '+'
                }
            ]
        };
    },

    // Pausa mínima entre el inicio de dos consultas pesadas del refresco
    // manual, y espera máxima por una consulta antes de seguir con la
    // siguiente. Lanzarlas todas a la vez ya provocó que PILOT cerrara la
    // sesión por ráfaga de requests.
    REFRESH_STEP_GAP_MS: 1500,
    REFRESH_STEP_MAX_WAIT_MS: 25000,
    REFRESH_TOTAL_MAX_MS: 120000,

    /**
     * Re-corre los widgets con datos en vivo (no toca reloj/logo) y sella la
     * hora del último refresco manual. Esa hora se muestra en la barra de
     * resumen; antes se re-pintaba en cada datachanged del árbol y parecía un
     * reloj.
     *
     * Las consultas pesadas se encadenan de a una: la siguiente arranca
     * cuando la anterior pintó su card (o vence REFRESH_STEP_MAX_WAIT_MS),
     * siempre tras REFRESH_STEP_GAP_MS. El botón queda ocupado hasta que
     * termina la cadena, y un segundo clic mientras tanto se ignora. El
     * fin de cada consulta se detecta por el primer pintado real de su card
     * (_refreshPending, ver updateCardBody), porque los loaders no exponen
     * callback de término.
     *
     * @return {Boolean} false si ya había un refresco en curso.
     */
    refreshAllWidgets: function () {
        var me = this;
        if (this._refreshAllBusy) { return false; }
        this._refreshAllBusy = true;
        this._lastManualRefresh = new Date();
        this._refreshPending = {};
        this._setRefreshBtnBusy(true);

        // Livianos: salen del árbol Online en memoria, sin request. El
        // skeleton va antes de refreshFleetStore para que el repintado no
        // quede tapado por él.
        this.showCardSkeleton('gps_signal', 'chips');
        this.showCardSkeleton('flota', 'donut');
        this.refreshFleetStore();
        this.populateMapFolderDropdown();
        this.populateFleetMapFolderDropdown();
        this.loadFleetMapClusters();

        var heavy = [
            { card: 'alertas_generales', skel: 'stats', run: function () { me.loadAlertasGenerales(); } },
            { card: 'eco_score', skel: 'donut', run: function () { me.loadEcoScore(); } },
            { card: 'top5km', skel: 'ranking', run: function () { me.loadTop5KmData(); } },
            { card: 'violations', skel: 'stats', run: function () { me.loadViolationsTrend(); } }
        ];
        // El mapa de Hotspots solo existe (y vale la pena consultarlo) en RAC.
        if (this._hotspotsPanel && this._activePreset !== 'lop') {
            heavy.push({ card: null, run: function () { me.loadFleetHeatmap(); } });
        }
        // Los widgets LOP encadenan sus propios reportes pesados en serie y
        // con pausa (y se saltan si ya hay una pasada en curso); van al final
        // para no competir con los de arriba.
        if (this._activePreset === 'lop') {
            heavy.push({ card: null, run: function () { me.loadLopWidgets(true); } });
        }

        this._runHeavySteps(heavy, function () {
            me._refreshAllBusy = false;
            me._setRefreshBtnBusy(false);
        });
        return true;
    },

    /**
     * Ejecuta consultas pesadas de a una, con pausa entre ellas (ver
     * REFRESH_STEP_GAP_MS). Cada paso es { card, skel, run }: si trae `card`,
     * el siguiente paso espera a que esa card pinte por primera vez (o a que
     * venza REFRESH_STEP_MAX_WAIT_MS); `skel` (opcional) pinta antes el
     * skeleton de carga. Lo usan el refresco manual y el arranque: con la
     * flota completa, lanzar todo a la vez agota las conexiones del navegador
     * hacia PILOT (los fetch vencen en la cola) y PILOT termina cerrando la
     * sesión.
     *
     * @param {Object[]} heavy Pasos a correr en orden.
     * @param {Function} [onFinish] Se llama al terminar la cadena completa.
     */
    _runHeavySteps: function (heavy, onFinish) {
        var me = this;
        var done = false;
        var startedAt = Date.now();
        var finish = function () {
            if (done) { return; }
            done = true;
            me._refreshPending = {};
            if (onFinish) { onFinish(); }
        };
        var waitAll = function () {
            var pending = me._refreshPending || {};
            var any = false;
            for (var k in pending) { if (pending.hasOwnProperty(k)) { any = true; break; } }
            if (!any || Date.now() - startedAt > me.REFRESH_TOTAL_MAX_MS) { finish(); return; }
            Ext.defer(waitAll, 300);
        };
        var i = 0;
        var next = function () {
            if (i >= heavy.length) { waitAll(); return; }
            var step = heavy[i++];
            var began = Date.now();
            try {
                if (step.card) {
                    if (step.skel) { me.showCardSkeleton(step.card, step.skel); }
                    me._refreshPending[step.card] = true;
                }
                step.run();
            } catch (err) {
                me.widgetErrorCode('REFRESH-STEP', err);
                if (step.card) { delete me._refreshPending[step.card]; }
            }
            var waitStep = function () {
                var settled = !step.card || !me._refreshPending[step.card];
                if (!settled && Date.now() - began < me.REFRESH_STEP_MAX_WAIT_MS) {
                    Ext.defer(waitStep, 250);
                    return;
                }
                Ext.defer(next, me.REFRESH_STEP_GAP_MS);
            };
            waitStep();
        };
        me._refreshPending = me._refreshPending || {};
        next();
    },

    /**
     * Carga inicial de los widgets con consultas pesadas, en serie. Va de lo
     * más útil a lo más caro; Hotspots, combustible y los widgets LOP se
     * difieren hasta que esta cadena termina (ver _afterStartup). Mientras
     * corre, el refresco automático de 60 s no arranca.
     */
    startInitialLoad: function () {
        var me = this;
        this._startupDone = false;
        this._refreshPending = {};
        var heavy = [
            { card: 'alertas_generales', run: function () { me.loadAlertasGenerales(); } },
            { card: 'eco_score', run: function () { me.loadEcoScore(); } },
            { card: 'top5km', run: function () { me.loadTop5KmData(); } },
            { card: 'violations', run: function () { me.loadViolationsTrend(); } },
            { card: null, run: function () {
                if (me._hotspotsNeedsLoad && me._hotspotsMap) {
                    me._hotspotsNeedsLoad = false;
                    me.loadFleetHeatmap();
                }
            } }
        ];
        this._runHeavySteps(heavy, function () {
            me._startupDone = true;
            // Cubre el caso de que el mapa se haya montado después de su paso.
            if (me._hotspotsNeedsLoad && me._hotspotsMap) {
                me._hotspotsNeedsLoad = false;
                me.loadFleetHeatmap();
            }
            var queue = me._startupQueue || [];
            me._startupQueue = [];
            // Lo diferido sale de a uno, separado, para no re-armar la ráfaga.
            for (var q = 0; q < queue.length; q++) {
                Ext.defer(queue[q], me.STARTUP_DEFERRED_GAP_MS * (q + 1));
            }
        });
    },

    // Separación entre cada tarea diferida del arranque (combustible, LOP).
    STARTUP_DEFERRED_GAP_MS: 15000,

    /**
     * Ejecuta `fn` cuando terminó la carga inicial (de inmediato, con un
     * pequeño retraso, si ya terminó). Evita que combustible y los widgets
     * LOP compitan con los reportes del arranque.
     */
    _afterStartup: function (fn) {
        if (this._startupDone) { Ext.defer(fn, 1500); return; }
        this._startupQueue = this._startupQueue || [];
        this._startupQueue.push(fn);
    },

    _setRefreshBtnBusy: function (busy) {
        var b = Ext.get('promatic_dashboard_enhancer-btn-refresh');
        if (b) { b[busy ? 'addCls' : 'removeCls']('promatic_dashboard_enhancer-ctrl-btn--busy'); }
    },

    /**
     * Refresco automático corto (60 s) SOLO de Alertas Generales y Sin Señal
     * GPS/Estado de Flota. Los rankings y reportes (Top KM, Safety Score,
     * Infracciones) y los mapas siguen siendo manuales o por cambio de
     * selección: son más caros y no necesitan esa frecuencia.
     *
     * Señal GPS/Estado de Flota se recalculan desde online_tree en memoria
     * (sin request); Alertas sí dispara requests reales. El guard
     * _autoRefreshBusy evita apilar otra pasada si la anterior (flota grande)
     * no terminó cuando cae el siguiente tick: las ráfagas sin freno ya
     * tumbaron la sesión de PILOT.
     */
    startAutoRefresh: function () {
        var me = this;
        if (me._autoRefreshTimer) { return; }
        me._autoRefreshTimer = setInterval(function () {
            // Durante la carga inicial no se suma otra consulta de alertas.
            if (me._autoRefreshBusy || !me._startupDone) { return; }
            me._autoRefreshBusy = true;
            me.refreshFleetStore();
            // withFleetVehicleIds reintenta hasta 40 veces cada 500 ms (~20
            // s) si el árbol Online no está listo. Este guard de respaldo
            // evita que _autoRefreshBusy quede en `true` para siempre si
            // onDone nunca llega.
            var settled = false;
            var guard = setTimeout(function () {
                if (settled) { return; }
                settled = true;
                me._autoRefreshBusy = false;
            }, 30000);
            me.loadAlertasGenerales(function () {
                if (settled) { return; }
                settled = true;
                clearTimeout(guard);
                me._autoRefreshBusy = false;
            });
        }, 60000);
    },

    // Pinta el skeleton de carga en el body de una card (si está montada).
    showCardSkeleton: function (id, kind) {
        this._paintingSkeleton = true;
        try {
            this.updateCardBody(id, Ext.DomHelper.markup(this.skeletonSpec(kind)), 0, true);
        } finally {
            this._paintingSkeleton = false;
        }
    },

    bindControlsBar: function (panel) {
        var me = this;
        var el = panel && panel.getEl && panel.getEl();
        if (!el || el._controlsBound) { return; }
        el._controlsBound = true;

        el.on('click', function (e) {
            var refreshBtn = e.getTarget('#promatic_dashboard_enhancer-btn-refresh', 5, true);
            if (refreshBtn) {
                e.preventDefault();
                me.refreshAllWidgets();
                return;
            }
            var minusBtn = e.getTarget('#promatic_dashboard_enhancer-scale-minus', 3, true);
            if (minusBtn) {
                e.preventDefault();
                me.setScalePct(me.getScalePct() - me.SCALE_STEP);
                return;
            }
            var plusBtn = e.getTarget('#promatic_dashboard_enhancer-scale-plus', 3, true);
            if (plusBtn) {
                e.preventDefault();
                me.setScalePct(me.getScalePct() + me.SCALE_STEP);
            }
        });

        this.applyScalePct(this.getScalePct());
    },

    // ---- Vistas (RAC / LOP) y modal "Controles" -------------------------

    UI_PRESET_STORAGE_KEY: 'promatic_dashboard_enhancer_ui_preset',
    UI_PRESETS: ['rac', 'lop'],
    VIEW_LOP_CLS: 'promatic_dashboard_enhancer-view-lop',

    /**
     * Fuente única de qué widget se muestra en cada vista. Estados por vista:
     * 'on' (visible y funcional), 'dev' (visible como placeholder "En
     * desarrollo") y 'off' (oculto). Una card con 'off' en una vista recibe la
     * clase que el CSS oculta en ella (viewVisibilityCls). `slot` ubica los
     * placeholders de LOP en la columna del shell donde deben aparecer
     * (lopSlotCards); al implementar uno, se pasa su estado lop a 'on'.
     */
    VIEW_WIDGETS: [
        { id: 'alertas_generales', title: 'Alertas Generales', rac: 'on', lop: 'on' },
        { id: 'gps_signal', title: 'Sin Señal GPS', rac: 'on', lop: 'on' },
        { id: 'flota', title: 'Estado de Flota', rac: 'on', lop: 'on' },
        { id: 'eco_score', title: 'Safety Score (ECO)', rac: 'on', lop: 'on' },
        { id: 'fleet_map', title: 'Ubicación Global de la Flota', rac: 'off', lop: 'on' },
        { id: 'top5km', title: 'Vehículos con Exceso de Kilometraje', rac: 'on', lop: 'off' },
        { id: 'violations', title: 'Tendencia de Infracciones de Manejo', rac: 'on', lop: 'off' },
        { id: 'hotspots', title: 'Hotspots de Pérdida de Conexión', rac: 'on', lop: 'off' },
        // lopKey enlaza con lopWidgetCards(): ahí vive la card real de cada
        // widget LOP. Sin lopKey (o sin card real) se pinta el placeholder.
        { id: 'lop_conduccion', title: 'Conducción', rac: 'off', lop: 'on', slot: 'mid', lopKey: 'conduccion' },
        { id: 'lop_estacionados', title: '% de Vehículos Estacionados por Sucursal', rac: 'off', lop: 'on', slot: 'mid', lopKey: 'estacionados' },
        { id: 'lop_mantencion', title: 'Kilometraje para Mantención', rac: 'off', lop: 'on', slot: 'mid', lopKey: 'mantencion' },
        { id: 'lop_rutas', title: 'Vehículos fuera de Rutas preestablecidas', rac: 'off', lop: 'dev', slot: 'mid', lopKey: 'rutas' },
        { id: 'lop_sucursales', title: 'Vehículos disponibles por Sucursal', rac: 'off', lop: 'on', slot: 'map', lopKey: 'sucursales' },
        { id: 'lop_combustible', title: 'Rendimiento de Combustible', rac: 'off', lop: 'on', slot: 'map', lopKey: 'combustible' },
        { id: 'lop_tag', title: 'Vehículos que más consumen TAG', rac: 'off', lop: 'on', slot: 'map', lopKey: 'tag' }
    ],

    /** Vista activa: override del navegador (modal Controles) > config.ui.preset > 'rac'. */
    effectiveUiPreset: function () {
        var stored = null;
        try { stored = window.localStorage && localStorage.getItem(this.UI_PRESET_STORAGE_KEY); } catch (err) { /* storage bloqueado */ }
        if (this.UI_PRESETS.indexOf(stored) !== -1) { return stored; }
        var cfg = (this.config && this.config.ui) || this.DEFAULT_CONFIG.ui || {};
        return this.UI_PRESETS.indexOf(cfg.preset) !== -1 ? cfg.preset : 'rac';
    },

    setUiPresetOverride: function (preset) {
        if (this.UI_PRESETS.indexOf(preset) === -1) { return; }
        try {
            if (window.localStorage) { localStorage.setItem(this.UI_PRESET_STORAGE_KEY, preset); }
        } catch (err) {
            this.widgetErrorCode('UI-PRESET-STORAGE', err);
        }
    },

    /** Clase que oculta la card en la vista donde su estado es 'off'. */
    viewVisibilityCls: function (cardId) {
        for (var i = 0; i < this.VIEW_WIDGETS.length; i++) {
            var w = this.VIEW_WIDGETS[i];
            if (w.id !== cardId) { continue; }
            if (w.lop === 'off') { return ' promatic_dashboard_enhancer-only-rac'; }
            if (w.rac === 'off') { return ' promatic_dashboard_enhancer-only-lop'; }
        }
        return '';
    },

    /**
     * Placeholders "En desarrollo" de los widgets de LOP de una columna del
     * shell ('mid' | 'map'). Es el punto de enganche para los widgets reales:
     * cada uno reemplaza el cuerpo de su card con updateCardBody(id, html) y
     * marca su estado lop en VIEW_WIDGETS.
     */
    lopSlotCards: function (slot) {
        var cards = [];
        var real = this.lopWidgetCards();
        for (var i = 0; i < this.VIEW_WIDGETS.length; i++) {
            var w = this.VIEW_WIDGETS[i];
            if (w.slot !== slot) { continue; }
            if (w.lopKey && real[w.lopKey]) {
                cards.push(real[w.lopKey]);
                continue;
            }
            cards.push(this.cardMarkup(w.id, {
                title: l(w.title),
                noFooter: true,
                bodyHtml: '<div class="promatic_dashboard_enhancer-wip">' + l('En desarrollo') + '</div>'
            }));
        }
        return cards;
    },

    /**
     * Aplica la vista efectiva: marca el panel raíz (el CSS oculta las cards
     * de la otra vista) y monta lo que solo existe en RAC. El mapa de
     * Hotspots se construye recién cuando la vista lo muestra: en LOP evita
     * su consulta pesada de cortes de conexión. Idempotente.
     */
    applyViewPreset: function () {
        var preset = this.effectiveUiPreset();
        var root = Ext.get('promatic_dashboard_enhancer-panel-root');
        if (root) { root[preset === 'lop' ? 'addCls' : 'removeCls'](this.VIEW_LOP_CLS); }
        this._activePreset = preset;
        if (preset === 'rac') { this.buildHotspotsMapPanel(); }
        var panel = Ext.getCmp('promatic_dashboard_enhancer-panel-root');
        if (panel && panel.updateLayout) { panel.updateLayout(); }
        var me = this;
        // Los widgets LOP piden reportes pesados (combustible, peajes): solo
        // se cargan cuando la vista los muestra. El retraso deja que el árbol
        // Online y los mapas terminen de montarse, de los que dependen.
        if (preset === 'lop') {
            this._afterStartup(function () {
                if (me._activePreset === 'lop') { me.loadLopWidgets(false); }
            });
        }
        // Un mapa montado mientras estaba oculto (display:none) midió 0 px;
        // al mostrarse se re-mide. Respaldo del ResizeObserver de cada mapa.
        Ext.defer(function () {
            if (me._fleetMap && me._fleetMap.checkResize) { me._fleetMap.checkResize(); }
            if (me._hotspotsMap && me._hotspotsMap.checkResize) { me._hotspotsMap.checkResize(); }
        }, 200);
    },

    /** Cierra el modal Controles si está abierto. */
    closeControlsModal: function () {
        if (this._controlsWin) {
            this._controlsWin.destroy();
            this._controlsWin = null;
        }
    },

    /** Valor efectivo de un parámetro de config, con respaldo al default. */
    _cfgValue: function (section, key) {
        var cfg = (this.config && this.config[section]) || this.DEFAULT_CONFIG[section] || {};
        return cfg[key];
    },

    /**
     * Filas de solo lectura del modal: parámetros efectivos con su aspecto
     * final. Aún no se editan desde la interfaz.
     */
    _controlsParamRows: function () {
        var days = l('días');
        return [
            [l('Alcance de la flota'), l('Toda la flota') + ' (' + l('hasta') + ' ' + this._cfgValue('fleet', 'maxVehicles') + ' ' + l('vehículos') + ')'],
            [l('Ventana de kilometraje'), this._cfgValue('top5km', 'windowDays') + ' ' + days],
            [l('Ventana de Safety Score'), this._cfgValue('ecoScore', 'windowDays') + ' ' + days],
            [l('Umbral de ralentí excesivo'), this._cfgValue('ecoScore', 'idleThresholdMin') + ' min'],
            [l('Ventana de infracciones'), this._cfgValue('violations', 'windowDays') + ' ' + days],
            [l('Ventana de Hotspots'), this._cfgValue('hotspots', 'windowDays') + ' ' + days],
            [l('Zona horaria'), this._cfgValue('clock', 'timeZone')]
        ];
    },

    /** Tabla de widgets de la vista elegida (vista previa, sin aplicar). */
    _controlsWidgetsHtml: function (preset) {
        var esc = Ext.String.htmlEncode;
        var label = { on: l('Activo'), dev: l('En desarrollo') };
        var rows = '';
        for (var i = 0; i < this.VIEW_WIDGETS.length; i++) {
            var w = this.VIEW_WIDGETS[i];
            var st = w[preset];
            if (st === 'off') { continue; }
            rows += '<tr><td>' + esc(l(w.title)) + '</td><td class="promatic_dashboard_enhancer-ctl__st promatic_dashboard_enhancer-ctl__st--' + st + '">' + esc(label[st]) + '</td></tr>';
        }
        return '<table class="promatic_dashboard_enhancer-ctl__table">' + rows + '</table>';
    },

    /**
     * Modal "Controles": selector de vista (RAC / LOP) y lectura de los
     * parámetros efectivos. Guardar persiste la vista en localStorage y la
     * aplica en vivo. La edición real de la config vivirá en un backend, por
     * eso el modal no escribe nada fuera del navegador.
     */
    openControlsModal: function () {
        var me = this;
        var esc = Ext.String.htmlEncode;
        this.closeControlsModal();
        var current = this.effectiveUiPreset();
        var idBase = 'promatic_dashboard_enhancer-ctl';

        var radio = function (value, title, desc) {
            return '<label class="promatic_dashboard_enhancer-ctl__opt">' +
                '<input type="radio" name="' + idBase + '-view" value="' + value + '"' + (value === current ? ' checked' : '') + '> ' +
                '<b>' + esc(title) + '</b><span>' + esc(desc) + '</span></label>';
        };
        var paramRows = '';
        var rows = this._controlsParamRows();
        for (var i = 0; i < rows.length; i++) {
            paramRows += '<tr><td>' + esc(rows[i][0]) + '</td><td>' + esc(String(rows[i][1])) + '</td></tr>';
        }

        var html =
            '<div class="promatic_dashboard_enhancer-ctl">' +
                '<h4>' + esc(l('Vista')) + '</h4>' +
                radio('rac', 'RAC', l('Renta de autos sueltos')) +
                radio('lop', 'LOP', l('Administrador de flota')) +
                '<h4>' + esc(l('Widgets de la vista elegida')) + '</h4>' +
                '<div id="' + idBase + '-widgets">' + this._controlsWidgetsHtml(current) + '</div>' +
                '<h4>' + esc(l('Parámetros vigentes (solo lectura)')) + '</h4>' +
                '<table class="promatic_dashboard_enhancer-ctl__table">' + paramRows + '</table>' +
                '<div id="' + idBase + '-msg" class="promatic_dashboard_enhancer-ctl__msg"></div>' +
            '</div>';

        this._controlsWin = Ext.create('Ext.window.Window', {
            title: l('Controles'),
            modal: true,
            resizable: false,
            width: 480,
            maxHeight: Math.max(320, Math.floor(window.innerHeight * 0.9)),
            scrollable: 'y',
            closeAction: 'destroy',
            html: html,
            buttons: [
                {
                    text: l('Guardar'),
                    handler: function () {
                        var checked = document.querySelector('input[name="' + idBase + '-view"]:checked');
                        var preset = checked ? checked.value : current;
                        me.setUiPresetOverride(preset);
                        me.applyViewPreset();
                        var msg = document.getElementById(idBase + '-msg');
                        if (msg) {
                            msg.textContent = l('La configuración de vista pasará a gestionarse desde el Backend en una próxima versión.');
                        }
                    }
                },
                { text: l('Cerrar'), handler: function () { me.closeControlsModal(); } }
            ],
            listeners: {
                afterrender: function (win) {
                    win.getEl().on('change', function (e) {
                        var t = e.getTarget('input[type=radio]');
                        var box = document.getElementById(idBase + '-widgets');
                        if (t && box) { box.innerHTML = me._controlsWidgetsHtml(t.value); }
                    });
                },
                destroy: function () { me._controlsWin = null; }
            }
        });
        this._controlsWin.show();
    },

    buildLopShell: function () {
        var rows = [
            this.rowMarkup([
                this.cardMarkup('reloj', { title: l('Hora Oficial'), noFooter: true }),
                this.cardMarkup('buscador', { title: l('Buscar un reporte…'), grow2: true, noFooter: true }),
                this.cardMarkup('logo', { title: 'LOGO', noFooter: true })
            ]),
            this.rowMarkup([
                this.cardMarkup('alertas', {
                    title: l('Últimas Alertas'), meta: 'events.php + ptm',
                    footerLabel: l('Abrir alertas')
                }),
                this.cardMarkup('velocidad_lop', {
                    title: l('Velocidad de conducción'), meta: 'speeding_pie.php',
                    footerLabel: l('Abrir reporte de velocidad')
                }),
                this.cardMarkup('ralenti', {
                    title: l('Ralentí'), meta: 'type=16',
                    footerLabel: l('Abrir reporte de ralentí')
                })
            ]),
            this.rowMarkup([
                this.cardMarkup('flota', {
                    title: l('Flota'), meta: 'online_tree.status',
                    footerLabel: l('Abrir árbol de flota')
                }),
                this.cardMarkup('top5km', {
                    title: l('Vehículos con Exceso de Kilometraje'), meta: 'rt=4',
                    footerLabel: l('Abrir reporte de kilometraje')
                })
            ]),
            this.rowMarkup([
                this.cardMarkup('hotspots', {
                    title: l('Hotspots de pérdida de conexión'), meta: 'type=15',
                    footerLabel: l('Abrir mapa de pérdida de conexión')
                }),
                this.cardMarkup('disponibles', {
                    title: l('Disponibles/ubicación'),
                    footerLabel: l('Abrir mapa de disponibilidad')
                })
            ])
        ];

        return Ext.create('Ext.Component', {
            cls: 'promatic_dashboard_enhancer-lop-shell',
            html: Ext.DomHelper.markup(rows)
        });
    },

    /**
     * Cada punto de falla conocido de un widget emite un código corto y
     * estable (ej. "KM-TIMEOUT"). Permite que el usuario reporte "vi el
     * código X" sin abrir la consola. No hay backend de logging: es solo
     * trazabilidad local. Catálogo en spec/datos.md.
     */
    widgetErrorCode: function (base, err, context) {
        var code = base + (err && err.name === 'AbortError' ? '-TIMEOUT' : '-FALLO');
        console.error('[promatic_dashboard_enhancer] ' + code + ':', err, context || '');
        return code;
    },

    getOnlineTree: function () {
        return (window.skeleton && skeleton.navigation && skeleton.navigation.online &&
            skeleton.navigation.online.online_tree) || null;
    },

    _plateAliasMap: null,
    _plateAliasSeq: 0,
    /**
     * Enmascara la patente cuando config.privacy.maskPlates está activo. En
     * PILOT el "Nombre de Vehículo" suele ser la patente literal (no hay
     * campo separado), así que mostrarla cruda expone un dato sensible del
     * cliente. Formato: 2 primeras letras + "-" + correlativo de 2 dígitos,
     * estable dentro de la sesión (mismo nombre → mismo alias). Con
     * maskPlates apagado devuelve el nombre tal cual.
     */
    displayName: function (name) {
        var cfg = (this.config && this.config.privacy) || (this.DEFAULT_CONFIG.privacy || {});
        if (!cfg.maskPlates || !name) { return name || ''; }
        if (!this._plateAliasMap) { this._plateAliasMap = {}; }
        var key = String(name);
        if (this._plateAliasMap[key]) { return this._plateAliasMap[key]; }
        var letters = (key.replace(/[^A-Za-z]/g, '').slice(0, 2) || 'VH').toUpperCase();
        this._plateAliasSeq++;
        var n = this._plateAliasSeq < 10 ? '0' + this._plateAliasSeq : String(this._plateAliasSeq);
        var alias = letters + '-' + n;
        this._plateAliasMap[key] = alias;
        return alias;
    },

    // Override de alcance que dejó el selector retirado. effectiveFleetScope()
    // ya no lo lee; se conserva con el resto del código de selección inerte.
    SCOPE_OVERRIDE_STORAGE_KEY: 'promatic_dashboard_enhancer_scope_override',

    // Escala manual (+/-). El navegador no puede detectar el tamaño físico de
    // un monitor externo: devicePixelRatio y resolución son iguales en un TV
    // grande y en un monitor de oficina si ambos son FullHD. Se persiste por
    // equipo/navegador, no por cuenta.
    SCALE_STORAGE_KEY: 'promatic_dashboard_enhancer_scale_pct',
    SCALE_MIN: 80,
    SCALE_MAX: 130,
    SCALE_STEP: 5,
    SCALE_DEFAULT: 100,

    getScalePct: function () {
        try {
            var v = window.localStorage && parseInt(localStorage.getItem(this.SCALE_STORAGE_KEY), 10);
            if (v && v >= this.SCALE_MIN && v <= this.SCALE_MAX) { return v; }
            return this.SCALE_DEFAULT;
        } catch (err) {
            return this.SCALE_DEFAULT;
        }
    },

    setScalePct: function (pct) {
        pct = Math.max(this.SCALE_MIN, Math.min(this.SCALE_MAX, pct));
        try {
            if (window.localStorage) { localStorage.setItem(this.SCALE_STORAGE_KEY, String(pct)); }
        } catch (err) {
            this.widgetErrorCode('SCALE-STORAGE', err);
        }
        this.applyScalePct(pct);
    },

    applyScalePct: function (pct) {
        var panelEl = Ext.get('promatic_dashboard_enhancer-panel-root');
        if (panelEl && panelEl.dom) {
            panelEl.dom.style.setProperty('--scale-factor', pct / 100);
        }
        var label = Ext.get('promatic_dashboard_enhancer-scale-pct');
        if (label) { label.setHtml(pct + '%'); }
    },

    getScopeOverride: function () {
        try {
            return (window.localStorage && localStorage.getItem(this.SCOPE_OVERRIDE_STORAGE_KEY)) || null;
        } catch (err) {
            return null;
        }
    },

    setScopeOverride: function (value) {
        try {
            if (!window.localStorage) { return; }
            if (value) {
                localStorage.setItem(this.SCOPE_OVERRIDE_STORAGE_KEY, value);
            } else {
                localStorage.removeItem(this.SCOPE_OVERRIDE_STORAGE_KEY);
            }
        } catch (err) {
            this.widgetErrorCode('SCOPE-OVERRIDE', err);
        }
    },

    /**
     * Alcance fijo en toda la flota: el dashboard no ofrece selector. Los
     * widgets deben mostrar la flota completa (hasta fleet.maxVehicles) y no
     * depender de lo que el usuario tenga marcado en el panel "Principal".
     */
    effectiveFleetScope: function () {
        return 'all';
    },

    /**
     * agent_ids marcados con checkbox en el panel "Principal"
     * (online_tree.getChecked()), filtrados a hojas reales: un nodo de
     * carpeta/modelo no tiene 'agentid'. Devuelve null si getChecked no está
     * disponible o no hay nada marcado (el llamador cae a la flota completa).
     */
    getPilotSelectionIds: function (onlineTree) {
        if (!onlineTree || typeof onlineTree.getChecked !== 'function') {
            return null;
        }
        var checked;
        try {
            checked = onlineTree.getChecked() || [];
        } catch (err) {
            this.widgetErrorCode('FLEET-SELECTION', err);
            return null;
        }
        var ids = [];
        for (var i = 0; i < checked.length; i++) {
            var node = checked[i];
            var agentid = node && (node.get ? node.get('agentid') : node.agentid);
            if (agentid) {
                ids.push(agentid);
            }
        }
        return ids.length ? ids : null;
    },

    /**
     * ¿Hay carpetas marcadas pero colapsadas, cuyos vehículos hijos NO están
     * materializados como checked en el store? El checkbox de una carpeta en
     * el árbol de PILOT solo propaga checked=true a los hijos al EXPANDIR la
     * carpeta; con la carpeta cerrada, getChecked()/cascadeBy ven la carpeta
     * marcada pero ninguna hoja.
     */
    hasCollapsedCheckedFolders: function (onlineTree) {
        var store = onlineTree && onlineTree.getStore && onlineTree.getStore();
        var root = store && store.getRoot && store.getRoot();
        if (!root) { return false; }
        var found = false;
        root.cascadeBy(function (node) {
            if (found) { return false; }
            // nodo marcado, sin agentid (= carpeta/grupo), colapsado
            if (node.get('checked') && !node.get('agentid') &&
                node.isExpandable && node.isExpandable() && !node.isExpanded()) {
                found = true;
                return false;
            }
        });
        return found;
    },

    /**
     * Expande las carpetas marcadas pero colapsadas, para que PILOT
     * materialice el checked de sus hijos. expand() es async y dispara
     * 'checkchange' en cada hijo, lo que re-renderiza vía el listener con
     * debounce. Las ramas se dejan expandidas a propósito (el usuario ve qué
     * entró al dashboard) y los checkboxes no se tocan. Devuelve true si
     * expandió al menos una.
     */
    expandCheckedFolders: function (onlineTree) {
        var store = onlineTree && onlineTree.getStore && onlineTree.getStore();
        var root = store && store.getRoot && store.getRoot();
        if (!root) { return false; }
        var toExpand = [];
        root.cascadeBy(function (node) {
            if (node.get('checked') && !node.get('agentid') &&
                node.isExpandable && node.isExpandable() && !node.isExpanded()) {
                toExpand.push(node);
            }
        });
        var me = this;
        for (var i = 0; i < toExpand.length; i++) {
            try {
                toExpand[i].expand();
            } catch (err) {
                this.widgetErrorCode('FLEET-EXPAND', err);
            }
        }
        // Red de seguridad: si expand() no llega a disparar 'checkchange'
        // (hijos ya checked en el modelo, solo la carpeta estaba colapsada),
        // el listener no re-renderiza. Un re-render diferido único cubre ese
        // caso; _selectionExpandRetry evita un bucle.
        if (toExpand.length > 0 && !this._selectionExpandRetry) {
            this._selectionExpandRetry = true;
            Ext.defer(function () {
                me._selectionExpandRetry = false;
                me.refreshFleetStore();
                me.loadTop5KmData();
            }, 900);
        }
        return toExpand.length > 0;
    },

    getScopedFleetRecords: function (onlineTree) {
        var records = onlineTree.getStore().getData().items;

        this._selectionEmpty = false;
        this._selectionCollapsed = false;
        var scope = null;
        if (this.effectiveFleetScope() === 'pilot-selection' && onlineTree &&
            typeof onlineTree.getChecked === 'function') {
            scope = this.getPilotSelectionIds(onlineTree);
            // Se revisan las carpetas colapsadas SIEMPRE que el scope sea
            // 'pilot-selection', no solo cuando no se detectó ninguna hoja.
            // Con flotas grandes y árboles de varios niveles es normal que
            // algunas carpetas ya estén expandidas mientras otras sub-
            // carpetas marcadas siguen colapsadas; un chequeo que solo corre
            // con 0 detectados nunca encuentra ese caso intermedio.
            if (this.hasCollapsedCheckedFolders(onlineTree)) {
                this._selectionCollapsed = true;
                this._selectionExpanding = this.expandCheckedFolders(onlineTree);
            } else {
                this._selectionCollapsed = false;
                this._selectionExpanding = false;
            }
            // getChecked() disponible pero ninguna hoja marcada: o el usuario
            // no seleccionó nada, o marcó carpetas colapsadas (PILOT no
            // materializa los hijos hasta expandir). El bloque anterior ya
            // disparó la expansión.
            if (!scope) {
                this._selectionEmpty = true;
                return [];
            }
        }
        if (!scope) {
            return records;
        }

        var scopeSet = {};
        for (var i = 0; i < scope.length; i++) {
            scopeSet[scope[i]] = true;
        }

        var filtered = [];
        for (var j = 0; j < records.length; j++) {
            var agentid = records[j].get('agentid');
            if (agentid && scopeSet[agentid]) {
                filtered.push(records[j]);
            }
        }

        return filtered;
    },

    getFleetVehicleIds: function (onlineTree) {
        var records = this.getScopedFleetRecords(onlineTree);
        var vehIds = [];
        for (var i = 0; i < records.length; i++) {
            var agentid = records[i].get('agentid');
            if (agentid) {
                vehIds.push(agentid);
            }
        }
        return vehIds;
    },

    /**
     * Vehículos del alcance que se movieron en los últimos `days` días, según
     * last_event.last_move del store (client-side, sin llamada). Un vehículo
     * sin movimiento en la ventana tiene 0 km, así que dejarlo fuera de la
     * consulta no cambia el ranking pero reduce el payload, lo que es crítico
     * con flotas grandes (no existe un endpoint de km por vehículo
     * precalculado).
     *
     * Devuelve los agent_ids ordenados por movimiento más reciente primero,
     * para que el llamador corte a un tope (top5km.activeVehicleCap)
     * quedándose con los más activos.
     */
    getRecentlyActiveIds: function (onlineTree, days) {
        var cutoff = Math.floor(Date.now() / 1000) - (days || 7) * 86400;
        var records = this.getScopedFleetRecords(onlineTree);
        var rows = [];
        for (var i = 0; i < records.length; i++) {
            var r = records[i];
            if (!r.get('agentid')) { continue; }
            var le = r.get('last_event') || (r.data && r.data.last_event) || {};
            var moved = Number(le.last_move) || Number(le.unixtimestamp) || 0;
            if (moved >= cutoff) {
                rows.push({ id: r.get('agentid'), moved: moved });
            }
        }
        rows.sort(function (a, b) { return b.moved - a.moved; });
        var ids = [];
        for (var j = 0; j < rows.length; j++) {
            ids.push(rows[j].id);
        }
        return ids;
    },

    /**
     * Polling acotado (40 x 500 ms = 20 s) hasta que el store de online_tree
     * tenga filas; luego bindea los listeners UNA sola vez (guard
     * _fleetBound) y hace el primer refresh. NO usa withFleetVehicleIds: su
     * rama de "lista vacía" se re-suscribe a 'datachanged' en cada disparo y,
     * con el árbol Online actualizándose seguido, se volvía un loop caliente.
     */
    bindFleetUpdates: function (attempt) {
        attempt = attempt || 0;
        var onlineTree = this.getOnlineTree();
        var store = onlineTree && onlineTree.getStore && onlineTree.getStore();
        var count = store && store.getData ? store.getData().items.length : 0;

        if (count === 0) {
            if (attempt < 40) {
                Ext.defer(this.bindFleetUpdates, 500, this, [attempt + 1]);
            } else if (this.summaryBar) {
                this.summaryBar.update(l('No se pudo cargar el árbol de vehículos de PILOT.'));
            }
            return;
        }

        if (!this._fleetBound) {
            store.on('datachanged', this.refreshFleetStore, this);
            store.on('update', this.refreshFleetStore, this);
            this._fleetBound = true;
        }

        var me = this;
        var onlineTree = this.getOnlineTree();
        if (!this._selectionBound && onlineTree && typeof onlineTree.on === 'function') {
            onlineTree.on('checkchange', function (node) {
                if (me.effectiveFleetScope() !== 'pilot-selection') { return; }
                // Si se marcó una carpeta colapsada, PILOT no propaga checked
                // a sus hijos hasta expandirla. Se fuerza la expansión acá
                // mismo: 'checkchange' sí llega para el nodo carpeta aunque
                // no cascadee a los hijos ocultos.
                if (node && node.get && node.get('checked') && !node.get('agentid') &&
                    node.isExpandable && node.isExpandable() && !node.isExpanded()) {
                    try { node.expand(); } catch (err) { me.widgetErrorCode('FLEET-EXPAND', err); }
                }
                if (me._selectionTimer) { return; }
                me._selectionTimer = Ext.defer(function () {
                    me._selectionTimer = null;
                    me.refreshFleetStore();
                    me.loadTop5KmData();
                    me.loadEcoScore();
                    me.populateMapFolderDropdown();
                    me.loadFleetHeatmap();
                }, 600);
            });
            this._selectionBound = true;
        }

        this.refreshFleetStore();
    },

    /**
     * Segundos desde el último evento recibido de un vehículo, como proxy de
     * "hace cuánto está sin señal". last_event.unixtimestamp es la marca más
     * reciente que mandó el dispositivo; para un vehículo con
     * is_server_online=false equivale a "cuándo se quedó mudo". Es una
     * aproximación razonable para buckets de 24 h (la fuente exacta sería
     * events.php type=15, que es una llamada HTTP aparte). Devuelve null si
     * no hay timestamp usable.
     */
    secondsSinceLastEvent: function (record) {
        var le = record.get('last_event') || (record.data && record.data.last_event);
        var ts = le && Number(le.unixtimestamp);
        if (!ts || !isFinite(ts)) {
            return null;
        }
        return Math.max(0, Math.floor(Date.now() / 1000) - ts);
    },

    // refreshFleetStore es el único punto que recorre online_tree en cada
    // 'datachanged'/'update': alimenta la barra de resumen, la card Flota y
    // la card Señal GPS con un mismo recorrido, sin HTTP. Los ids
    // 'flota'/'gps_signal' los comparten el shell RAC y el LOP, pero solo uno
    // está montado a la vez.
    //
    // Throttle: el árbol Online dispara 'datachanged' cientos de veces por
    // segundo con flotas grandes (cada ping de cada vehículo). Se coalesce en
    // una corrida cada 2 s como máximo: leading edge (la primera pinta al
    // toque) + trailing (una más al final de la ráfaga).
    FLEET_REFRESH_MIN_GAP_MS: 2000,

    refreshFleetStore: function () {
        var me = this;

        if (this._fleetRefreshTimer) {
            return;
        }

        var run = function () {
            me._fleetRefreshTimer = null;
            me._fleetRefreshLast = Date.now();
            try {
                me._refreshFleetStore();
            } catch (err) {
                if (!me._fleetRefreshErrLogged) {
                    me._fleetRefreshErrLogged = true;
                    me.widgetErrorCode('FLEET-REFRESH', err);
                }
            }
        };

        var since = this._fleetRefreshLast ? (Date.now() - this._fleetRefreshLast) : Infinity;
        if (since >= this.FLEET_REFRESH_MIN_GAP_MS) {
            run();
        } else {
            this._fleetRefreshTimer = Ext.defer(run, this.FLEET_REFRESH_MIN_GAP_MS - since);
        }
    },

    // Tope de reintentos ante la falsa pinta inicial: online_tree materializa
    // las filas del store antes de que PILOT sincronice is_server_online por
    // cada una (llega en un 'datachanged'/'update' posterior). Sin esperar,
    // toda la flota se ve "offline" por unos segundos al montar.
    FLEET_SETTLE_MAX_RETRIES: 6,
    FLEET_SETTLE_RETRY_MS: 700,

    _refreshFleetStore: function () {
        var onlineTree = this.getOnlineTree();
        if (!onlineTree) {
            return;
        }

        var records = this.getScopedFleetRecords(onlineTree);

        // fleet.scope 'pilot-selection' sin hojas marcadas en el panel
        // "Principal": estado vacío explícito en vez de números en 0.
        if (this._selectionEmpty) {
            var msgSel;
            if (this._selectionExpanding) {
                msgSel = l('Cargando vehículos de las carpetas seleccionadas…');
            } else if (this._selectionCollapsed) {
                msgSel = l('Expande en el panel "Principal" las carpetas que marcaste para incluir sus vehículos.');
            } else {
                msgSel = l('Selecciona vehículos en el panel "Principal" para ver el resumen.');
            }
            if (this.summaryBar) { this.summaryBar.update(msgSel); }
            this.updateCardBody('flota', msgSel, 0, true);
            this.updateCardBody('gps_signal', msgSel);
            return;
        }

        var total = 0;
        var moving = 0, parked = 0, offlineCount = 0;
        var gps24 = 0, gps48 = 0, gpsMore = 0, gpsNoData = 0;
        var offlineNoTimestamp = 0;
        var gps24Rows = [], gps48Rows = [], gpsMoreRows = [], gpsNoDataRows = [];
        var DAY = 86400;

        for (var i = 0; i < records.length; i++) {
            var r = records[i];

            if (!r.get('agentid')) {
                continue;
            }

            var isOnline = !!r.get('is_server_online');
            var statusText = r.get('status') || '';
            total++;

            if (!isOnline) {
                offlineCount++;
                var age = this.secondsSinceLastEvent(r);
                var latLon = this._recordLatLon(r);
                var row = {
                    veh: r.get('name'),
                    ts: age !== null ? (Math.floor(Date.now() / 1000) - age) : null,
                    lat: latLon ? latLon[0] : null,
                    lon: latLon ? latLon[1] : null
                };
                if (age === null) {
                    // last_event ausente incluso tras agotar los reintentos
                    // de sincronización: tiene bucket propio en vez de caer
                    // en "Más de 48h". "Sin dato" no es lo mismo que
                    // "confirmado hace más de 48h"; mezclarlos exageraba el
                    // bucket más severo.
                    offlineNoTimestamp++;
                    gpsNoData++;
                    gpsNoDataRows.push(row);
                } else if (age < DAY) {
                    gps24++;
                    gps24Rows.push(row);
                } else if (age < 2 * DAY) {
                    gps48++;
                    gps48Rows.push(row);
                } else {
                    gpsMore++;
                    gpsMoreRows.push(row);
                }
            } else if (statusText.indexOf('movimiento') !== -1) {
                // "En movimiento X km/h" vs. "Estacionamiento...": se deduce
                // del texto de estado, que es el dato real disponible (no hay
                // un campo separado).
                moving++;
            } else {
                parked++;
            }
        }

        // Falsa pinta inicial, 2 variantes de la misma causa raíz
        // (is_server_online/last_event aún sin sincronizar tras montar o
        // cambiar de carpeta, no un apagón real):
        // 1) 100% offline con flota no vacía.
        // 2) Vehículos offline cuyo last_event todavía no llegó: sin este
        //   guard, secondsSinceLastEvent() devuelve null y los mete a todos
        //   en "Más de 48h" hasta que la sincronización termina sola. Umbral:
        //   más de la mitad de los offline sin dato.
        var settleNeeded = total > 0 && (
            offlineCount === total ||
            (offlineCount > 0 && offlineNoTimestamp > offlineCount / 2)
        );
        if (settleNeeded &&
            (this._fleetSettleAttempt || 0) < this.FLEET_SETTLE_MAX_RETRIES) {
            this._fleetSettleAttempt = (this._fleetSettleAttempt || 0) + 1;
            Ext.defer(this.refreshFleetStore, this.FLEET_SETTLE_RETRY_MS, this);
            return;
        }
        this._fleetSettleAttempt = 0;

        // Log solo cuando los números cambian — con flota estable, silencio.
        var sig = total + '/' + offlineCount + '/' + moving + '/' + parked +
            '/' + gps24 + '/' + gps48 + '/' + gpsMore + '/' + gpsNoData;
        if (sig !== this._fleetSig) {
            this._fleetSig = sig;
            Store.promatic_dashboard_enhancer.Module.debugLog('flota: total=' + total +
                ' online=' + (total - offlineCount) + ' offline=' + offlineCount +
                ' | señal GPS <24h=' + gps24 + ' 24-48h=' + gps48 + ' >48h=' + gpsMore + ' sin dato=' + gpsNoData);
        }

        // Cache para los exportadores. rows24/rows48/rowsMore/rowsNoData
        // alimentan buildGpsSignalReport (modal de detalle de cada chip de
        // Sin Señal GPS).
        this._lastFleetCounts = { total: total, moving: moving, parked: parked, offline: offlineCount };
        this._lastGpsBuckets = {
            b24: gps24, b48: gps48, bMore: gpsMore, bNoData: gpsNoData,
            rows24: gps24Rows, rows48: gps48Rows, rowsMore: gpsMoreRows, rowsNoData: gpsNoDataRows
        };

        this.updateSummary(total, total - offlineCount);
        this.updateFlotaLopCard(total, moving, parked, offlineCount);
        this.updateGpsSignalCard(gps24, gps48, gpsMore, gpsNoData);
    },

    /**
     * Reloj puro cliente, sin API. Se pinta la card una vez y después solo se
     * actualiza el nodo de la hora cada segundo (updateCardBody re-parsearía
     * el HTML completo). El setInterval no se limpia: el módulo vive toda la
     * sesión (es un nav tab) y no tiene teardown.
     */
    clockConfig: function () {
        var c = (this.config && this.config.clock) || this.DEFAULT_CONFIG.clock;
        return {
            timeZone: c.timeZone || 'America/Santiago',
            locale: c.locale || 'es-CL',
            label: c.label || 'Hora Oficial'
        };
    },

    chileTime: function () {
        var cfg = this.clockConfig();
        try {
            var parts = new Intl.DateTimeFormat(cfg.locale, {
                timeZone: cfg.timeZone,
                hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
            }).formatToParts(new Date());
            var m = {};
            parts.forEach(function (p) { m[p.type] = p.value; });
            return m.hour + ':' + m.minute + ':' + m.second;
        } catch (err) {
            return Ext.Date.format(new Date(), 'H:i:s');
        }
    },

    startClock: function () {
        var me = this;
        var tick = function () {
            var el = Ext.get('promatic_dashboard_enhancer-clock-time');
            if (el) {
                el.dom.textContent = me.chileTime();
            }
        };

        this.updateCardBody('reloj', Ext.DomHelper.markup({
            cls: 'promatic_dashboard_enhancer-clock',
            cn: [
                {
                    id: 'promatic_dashboard_enhancer-clock-time',
                    cls: 'promatic_dashboard_enhancer-clock__time',
                    html: me.chileTime()
                }
            ]
        }));

        setInterval(tick, 1000);
    },

    renderLogo: function () {
        this.updateCardBody('logo', Ext.DomHelper.markup({
            cls: 'promatic_dashboard_enhancer-logo',
            cn: [
                { tag: 'img', src: this.getModuleBaseUrl() + 'img/dashboard-enhancer-resized-small.jpg', alt: 'Dashboard Enhancer' },
                {
                    tag: 'span',
                    cls: 'promatic_dashboard_enhancer-version',
                    // Se muestra el moduleBuild completo (fecha+hora), no
                    // solo el SemVer: con varias publicaciones el mismo día,
                    // sin bump de SemVer, serían indistinguibles en PILOT. El
                    // build crudo permite confirmar qué publicación exacta
                    // cargó el navegador.
                    html: 'v' + this.version + ' · build ' + (this.moduleBuild || '')
                }
            ]
        }));
    },

    /**
     * Alertas Generales (card 'alertas_generales'), 2 categorías
     * independientes:
     * - Accidentes: events.php type=4911 ("Crash Detection Alert"), ventana
     *   de 30 días. Ver fetchAccidentVehicles.
     * - Requiere mantención: dashboard.php cmd=ptm (recordatorios); se
     *   cuentan los ligados a vehículo (link_type != 'drivers'). El shape de
     *   ptm no está confirmado en una cuenta con datos; el log de depuración
     *   del raw sirve para verificarlo. Si una categoría falla muestra "N/D" sin
     *   tumbar la otra.
     *
     * onDone (opcional): se llama cuando el ciclo completo terminó, para que
     * un llamador espere el fin real sin convertir la función a promesa
     * (withFleetVehicleIds es callback-based con reintentos).
     */
    loadAlertasGenerales: function (onDone) {
        var me = this;

        this.withFleetVehicleIds(function (vehIds) {
            var csv = vehIds.join(',');
            var stop = new Date();
            var start = new Date();
            start.setDate(start.getDate() - 30);
            var fmt = function (d) { return d.toISOString().slice(0, 10); };
            me._alertRange = { start: start, stop: stop };

            // Fuente de accidentes: events.php type=4911, NO reports.php
            // report_type=254. Ese último tenía un desfase de huso horario y
            // una latencia de ~4 h del lado de PILOT.
            var accidentes = me.fetchAccidentVehicles(csv, start, stop)
                .then(function (rows) {
                    me._alertAccidentesRows = rows;
                    me._alertAccidentesIds = rows
                        .map(function (r) { return r.agentId; })
                        .filter(function (id) { return id != null; });
                    return rows.length;
                })
                .catch(function (err) {
                    me.widgetErrorCode('ALERT-ACC', err);
                    me._alertAccidentesRows = [];
                    me._alertAccidentesIds = [];
                    return null;
                });

            var mantencion = me.fetchMantencionCount(vehIds)
                .catch(function (err) { me.widgetErrorCode('ALERT-MANT', err); return null; });

            // Sin borderAlert.eventType la categoría no está conectada para
            // esta cuenta: la tarjeta queda en "EN DESARROLLO" (undefined).
            var border = Promise.resolve(undefined);
            var bcfg = (me.config && me.config.borderAlert) || me.DEFAULT_CONFIG.borderAlert || {};
            me._alertBorderEnabled = !!bcfg.eventType;
            me._alertBorderIds = [];
            me._alertBorderRows = [];
            if (me._alertBorderEnabled) {
                var bStart = new Date();
                bStart.setDate(bStart.getDate() - (bcfg.windowDays || 30));
                var sinceMs = bcfg.since ? Date.parse(bcfg.since) : NaN;
                border = me.fetchBorderStopRows(csv, bStart, stop, bcfg.eventType, isNaN(sinceMs) ? 0 : sinceMs)
                    .then(function (rows) {
                        // El conteo es de vehículos distintos, no de
                        // eventos: un vehículo detenido repite el aviso.
                        var seen = {}, ids = [];
                        for (var i = 0; i < rows.length; i++) {
                            var key = rows[i].agentId != null ? rows[i].agentId : rows[i].veh;
                            if (key === '' || seen[key]) { continue; }
                            seen[key] = 1;
                            if (rows[i].agentId != null) { ids.push(rows[i].agentId); }
                        }
                        me._alertBorderIds = ids;
                        me._alertBorderRows = rows;
                        return Object.keys(seen).length;
                    })
                    .catch(function (err) {
                        me.widgetErrorCode('ALERT-BORDER', err);
                        return null;
                    });
            }

            Promise.all([accidentes, mantencion, border]).then(function (r) {
                me._alertAccidentes = r[0];
                me._alertMantencion = r[1];
                me._alertBorder = r[2];
                Store.promatic_dashboard_enhancer.Module.debugLog('alertas generales: accidentes=' +
                    r[0] + ' requiere_mantencion=' + r[1] + ' paso_fronterizo=' + r[2]);
                // Combustible corre aparte (lotes con pausa) y vuelve a
                // dibujar las tarjetas al terminar; no demora las demás.
                if (me._startupDone) {
                    me.loadFuelAlerts(vehIds);
                } else if (!me._fuelQueued) {
                    me._fuelQueued = true;
                    me._afterStartup(function () { me.loadFuelAlerts(vehIds); });
                }
                me.renderAlertasGenerales();
                if (typeof onDone === 'function') { onDone(); }
            });
        });
    },

    /**
     * Circuit breaker: true si `key` ya dio 401 en esta sesión. Se resetea
     * solo con F5: PILOT podría desbloquear el endpoint en cualquier momento
     * y no debe quedar apagado para siempre por un error pasajero.
     */
    _isEndpointBlocked: function (key) {
        return !!(this._blockedEndpoints && this._blockedEndpoints[key]);
    },
    _markEndpointBlocked: function (key) {
        if (!this._blockedEndpoints) { this._blockedEndpoints = {}; }
        if (!this._blockedEndpoints[key]) {
            this._blockedEndpoints[key] = true;
            console.warn('[promatic_dashboard_enhancer] ' + key +
                ' marcado como bloqueado (401) — no se reintenta hasta recargar la página.');
        }
    },

    /**
     * Como fetchEventCount, pero devuelve la lista de agent_ids distintos que
     * aparecen en los eventos del tipo/rango; alimenta el link "abrir
     * informe".
     */
    fetchEventVehicles: function (vehIdsCsv, type, dateStart, dateStop) {
        var me = this;
        var breakerKey = 'events.php:type=' + type;
        if (this._isEndpointBlocked(breakerKey)) { return Promise.resolve([]); }
        var qs = 'cmd=search&veh=' + encodeURIComponent(vehIdsCsv) +
            '&type=' + encodeURIComponent(type) +
            '&date_start=' + encodeURIComponent(dateStart) +
            '&date_stop=' + encodeURIComponent(dateStop) +
            '&limit=1000&page=1&start=0';
        return fetch('/backend/ax/mod/events.php?' + qs, { credentials: 'include' })
            .then(function (resp) {
                if (resp.status === 401) { me._markEndpointBlocked(breakerKey); }
                if (!resp.ok) { throw new Error('HTTP ' + resp.status); }
                return resp.json();
            })
            .then(function (data) {
                var items = (data && data.items) || [];
                var seen = {}, ids = [];
                for (var i = 0; i < items.length; i++) {
                    var aid = items[i].agent_id || items[i].agentid || items[i].veh || items[i].object_id;
                    if (aid != null && !seen[aid]) { seen[aid] = 1; ids.push(Number(aid)); }
                }
                return ids;
            });
    },

    /**
     * Accidentes vía events.php type=4911. Se descubrió interceptando
     * fetch/XHR mientras se navegaba el panel nativo "Events" de PILOT: trae
     * los eventos a tiempo y con el horario correcto (el report_type=254
     * anterior no, ver loadAlertasGenerales). Respuesta: árbol anidado
     * vehículo → carpeta "Crash Detection Alert" → eventos (schema completo
     * en spec/api.md).
     */
    fetchAccidentVehicles: function (vehIdsCsv, startDate, stopDate) {
        var me = this;
        var isoNoMs = function (d) { return d.toISOString().slice(0, 19); };
        var qs = 'cmd=search&operating_mode=tree' +
            '&veh=' + encodeURIComponent(vehIdsCsv) +
            '&type=4911' +
            '&date_start=' + encodeURIComponent(isoNoMs(startDate)) +
            '&date_stop=' + encodeURIComponent(isoNoMs(stopDate)) +
            '&limit=5000&page=1&start=0&node=root';
        var ctrl = new AbortController();
        var to = setTimeout(function () { ctrl.abort(); }, 45000);

        return fetch('/backend/ax/mod/events.php?' + qs, { credentials: 'include', signal: ctrl.signal })
            .then(function (resp) {
                if (!resp.ok) { throw new Error('HTTP ' + resp.status); }
                return resp.json();
            })
            .then(function (tree) {
                Store.promatic_dashboard_enhancer.Module.debugLog('accidentes (events.php type=4911):', tree);
                var vehicles = Array.isArray(tree) ? tree : [];
                var seenEventIds = {}, rows = [];
                for (var v = 0; v < vehicles.length; v++) {
                    var folders = (vehicles[v] && vehicles[v].children) || [];
                    for (var f = 0; f < folders.length; f++) {
                        var events = (folders[f] && folders[f].children) || [];
                        for (var e = 0; e < events.length; e++) {
                            var ev = events[e] || {};
                            // "Real crash detected, calibrated/not
                            // calibrated" es el evento real; "Full crash
                            // trace, ..." repite la misma detección (un
                            // vehículo trae varios "Full crash trace" y como
                            // máximo 1 "Real crash detected" por accidente).
                            // El sufijo "not calibrated" también cuenta: se
                            // prefiere no subestimar el conteo real.
                            // `calibrated` se guarda para mostrarlo en la
                            // tabla/PDF.
                            if (!ev.text || ev.text.indexOf('Real crash detected') !== 0) { continue; }
                            if (ev.id != null && seenEventIds[ev.id]) { continue; }
                            if (ev.id != null) { seenEventIds[ev.id] = 1; }
                            rows.push({
                                agentId: ev.agent_id != null ? Number(ev.agent_id) : null,
                                veh: ev.veh != null ? String(ev.veh) : '',
                                ts: ev.ts != null ? Number(ev.ts) : null,
                                lat: ev.lat != null ? Number(ev.lat) : null,
                                lon: ev.lon != null ? Number(ev.lon) : null,
                                calibrated: ev.text.indexOf('not calibrated') === -1
                            });
                        }
                    }
                }
                return rows;
            })
            .finally(function () { clearTimeout(to); });
    },

    /**
     * Detenciones en pasos fronterizos vía events.php con el `type` de la
     * notificación configurada en borderAlert.eventType. Misma forma de
     * respuesta que Accidentes (árbol vehículo → carpeta con el nombre de la
     * notificación → eventos). Devuelve los eventos ya filtrados por
     * borderAlert.since; un mismo vehículo puede traer varios.
     */
    fetchBorderStopRows: function (vehIdsCsv, startDate, stopDate, eventType, sinceMs) {
        var isoNoMs = function (d) { return d.toISOString().slice(0, 19); };
        var qs = 'cmd=search&operating_mode=tree' +
            '&veh=' + encodeURIComponent(vehIdsCsv) +
            '&type=' + encodeURIComponent(eventType) +
            '&date_start=' + encodeURIComponent(isoNoMs(startDate)) +
            '&date_stop=' + encodeURIComponent(isoNoMs(stopDate)) +
            '&limit=5000&page=1&start=0&node=root';
        var ctrl = new AbortController();
        var to = setTimeout(function () { ctrl.abort(); }, 45000);

        return fetch('/backend/ax/mod/events.php?' + qs, { credentials: 'include', signal: ctrl.signal })
            .then(function (resp) {
                if (!resp.ok) { throw new Error('HTTP ' + resp.status); }
                return resp.json();
            })
            .then(function (tree) {
                Store.promatic_dashboard_enhancer.Module.debugLog('paso fronterizo (events.php type=' + eventType + '):', tree);
                var vehicles = Array.isArray(tree) ? tree : [];
                var seenEventIds = {}, rows = [];
                for (var v = 0; v < vehicles.length; v++) {
                    var folders = (vehicles[v] && vehicles[v].children) || [];
                    for (var f = 0; f < folders.length; f++) {
                        var events = (folders[f] && folders[f].children) || [];
                        for (var e = 0; e < events.length; e++) {
                            var ev = events[e] || {};
                            if (ev.id != null && seenEventIds[ev.id]) { continue; }
                            if (ev.id != null) { seenEventIds[ev.id] = 1; }
                            var ts = ev.ts != null ? Number(ev.ts) : null;
                            if (sinceMs && (ts == null || ts * 1000 < sinceMs)) { continue; }
                            rows.push({
                                agentId: ev.agent_id != null ? Number(ev.agent_id) : null,
                                veh: ev.veh != null ? String(ev.veh) : '',
                                ts: ts,
                                lat: ev.lat != null ? Number(ev.lat) : null,
                                lon: ev.lon != null ? Number(ev.lon) : null,
                                zone: me._borderEventZone(ev.msg)
                            });
                        }
                    }
                }
                return rows;
            })
            .finally(function () { clearTimeout(to); });
    },

    /**
     * Nombre de la geocerca de un evento de la notificación de paso
     * fronterizo. El msg es una "Complex notification" con tramos separados
     * por ';' o '<#>', p. ej. "<patente>:Stop In Geofence|<geocerca>" o
     * "<patente>:Geozone|<geocerca>|<id>|0". Se prefiere la detención y se
     * cae a la geozona; '' si el formato no se reconoce.
     */
    _borderEventZone: function (msg) {
        var m = /Stop In Geofence\|([^;<|]+)/.exec(msg || '') || /Geozone\|([^;<|]+)/.exec(msg || '');
        return m ? m[1].trim() : '';
    },

    /**
     * Ralentí excesivo: vehículos con Excess Idle (c1 del report_type=223, en
     * segundos) sobre ecoScore.idleThresholdMin minutos en la ventana. Usa la
     * respuesta ya cacheada por loadEcoScore, sin otra llamada.
     */
    refreshRalentiAlert: function () {
        var resp = this._lastEcoResp;
        if (!resp || !resp.data) { this._alertRalenti = null; this._alertRalentiIds = []; this.renderAlertasGenerales(); return; }
        var cfg = (this.config && this.config.ecoScore) || this.DEFAULT_CONFIG.ecoScore;
        var thresholdSec = (cfg.idleThresholdMin || 120) * 60;

        // Mapa nombre→agentid del árbol: el reporte 223 agrupa por patente y
        // no trae agent_id.
        var nameToId = {};
        var onlineTree = this.getOnlineTree();
        if (onlineTree) {
            var recs = this.getScopedFleetRecords(onlineTree);
            for (var r = 0; r < recs.length; r++) {
                var nm = recs[r].get('name');
                if (nm) { nameToId[String(nm)] = recs[r].get('agentid'); }
            }
        }

        var n = 0, ids = [];
        for (var g in resp.data) {
            if (!resp.data.hasOwnProperty(g)) { continue; }
            var vehs = resp.data[g];
            for (var p in vehs) {
                if (!vehs.hasOwnProperty(p)) { continue; }
                var c = vehs[p];
                if (c && c.length > 1 && Number(c[1]) >= thresholdSec) {
                    n++;
                    var id = nameToId[String(c[0] || p)];
                    if (id != null) { ids.push(Number(id)); }
                }
            }
        }
        this._alertRalenti = n;
        this._alertRalentiIds = ids;
        this.renderAlertasGenerales();
    },

    /**
     * Alerta de mantención: sondeo a los endpoints del módulo Técnico-
     * Operacional (mod/to/). No están tipados: se prueban inspections y
     * services y se cuentan los items que parezcan "vencido/pendiente". Si
     * ninguno responde algo usable devuelve null (la card muestra "N/D" en
     * vez de romper).
     */
    fetchMantencionCount: function (vehIds) {
        var me = this;
        var csv = vehIds.join(',');
        // Los cmd están confirmados en spec/api.md (inspections→forms,
        // services→list). En la cuenta de pruebas ambos devolvieron items:[]
        // (sin datos). Se prueban con y sin filtro de vehículos por si el
        // schema de una cuenta con datos lo requiere.
        var endpoints = [
            { url: '/backend/ax/mod/to/inspections.php?cmd=forms&veh=' + encodeURIComponent(csv), breakerKey: 'mod/to/inspections.php' },
            { url: '/backend/ax/mod/to/inspections.php?cmd=forms', breakerKey: 'mod/to/inspections.php' },
            { url: '/backend/ax/mod/to/services.php?cmd=list&veh=' + encodeURIComponent(csv), breakerKey: 'mod/to/services.php' },
            { url: '/backend/ax/mod/to/services.php?cmd=list', breakerKey: 'mod/to/services.php' }
        ];
        var tryOne = function (i) {
            if (i >= endpoints.length) { return Promise.resolve(null); }
            // Un 401 previo para este endpoint (con o sin filtro de
            // vehículos) casi seguro se repite: se salta al siguiente sin
            // gastar el request.
            if (me._isEndpointBlocked(endpoints[i].breakerKey)) { return tryOne(i + 1); }
            return fetch(endpoints[i].url, { credentials: 'include' })
                .then(function (resp) {
                    if (resp.status === 401) { me._markEndpointBlocked(endpoints[i].breakerKey); }
                    if (!resp.ok) { throw new Error('HTTP ' + resp.status); }
                    return resp.json();
                })
                .then(function (data) {
                    Store.promatic_dashboard_enhancer.Module.debugLog('mantención sondeo ' + endpoints[i].url + ':', data);
                    var items = (data && (data.data || data.items || data.list || data.rows)) || [];
                    if (!Array.isArray(items)) {
                        // a veces viene como objeto keyed por id
                        items = (items && typeof items === 'object') ? Object.keys(items).map(function (k) { return items[k]; }) : [];
                    }
                    if (items.length === 0) { return tryOne(i + 1); }
                    var n = 0;
                    for (var j = 0; j < items.length; j++) {
                        var it = items[j] || {};
                        var st = String(it.status || it.state || it.result || '').toLowerCase();
                        if (/venc|pend|overdue|\bdue\b|expired|required/.test(st)) { n++; }
                        else if (it.overdue === true || it.is_due === true) { n++; }
                    }
                    // Sin un campo de estado reconocible, se cuentan todos
                    // los items como "recordatorio activo": es el
                    // comportamiento conservador hasta tipar el schema.
                    return n > 0 ? n : items.length;
                })
                .catch(function () { return tryOne(i + 1); });
        };
        return tryOne(0);
    },

    // ------------------------------------------------------------------
    // Alertas de combustible (Alertas Generales: "Inconsistencias en Carga"
    // y "Drenaje de Combustible").
    //
    // PILOT no genera eventos nativos para sensores de combustible de
    // semanticid 2, así que las cargas y drenajes se CALCULAN sobre la serie
    // de nivel del reporte "Fuel sensor report" (reports.php report_type=16).
    // Es una heurística: todo resultado se rotula "posible", nunca como hecho.
    //
    // La configuración de sensores es por vehículo: la ausencia de sensor es
    // "N/D", no cero, y siempre se muestra la cobertura (N de M con sensor).
    //
    // El esquema real de la respuesta del reporte 16 no está confirmado:
    // _parseFuelReport es defensivo y, si no reconoce la respuesta, la
    // tarjeta queda "EN DESARROLLO" en vez de mostrar un número inventado.
    // Con el flag de debug activo, la respuesta cruda de los primeros
    // vehículos se vuelca a consola para poder fijar el esquema.
    // ------------------------------------------------------------------

    /** Config de combustible con defaults; ver DEFAULT_CONFIG.fuel. */
    _fuelCfg: function () {
        return Ext.apply({}, (this.config && this.config.fuel) || {}, this.DEFAULT_CONFIG.fuel);
    },

    /**
     * Detecta posibles cargas y drenajes en una serie de nivel.
     *
     * Se ignora el movimiento: con el vehículo en marcha el líquido se
     * balancea y el sensor oscila, así que solo se evalúan tramos donde la
     * velocidad es <= stopSpeedKmh en todas las muestras involucradas. Si la
     * serie no trae velocidad, no se puede descartar movimiento y los eventos
     * salen con speedKnown=false (confianza baja).
     *
     * Los umbrales son un porcentaje del nivel máximo observado (o de
     * capacityHint): así no dependen de la unidad del sensor (litros, % o
     * crudo), que el reporte no declara. Una mediana de 3 muestras filtra
     * picos aislados, y un salto solo cuenta si las muestras siguientes lo
     * confirman (descarta el rebote de un pico).
     *
     * Una carga se acepta también entre dos muestras separadas por un hueco
     * (hasta maxGapMin): el equipo suele no reportar con el motor apagado, y
     * un alza de nivel no puede ser consumo. Un drenaje solo se acepta dentro
     * de windowMin, porque una baja a lo largo de un hueco largo es consumo.
     *
     * @param {Array<{ts:number, v:number, spd:(number|null)}>} samples ts en segundos
     * @param {Object} o opciones (ver DEFAULT_CONFIG.fuel)
     * @return {{events:Array, ref:number, n:number, speedKnown:boolean}}
     */
    _detectFuelEvents: function (samples, o) {
        var s = (samples || []).filter(function (p) { return p && isFinite(p.ts) && isFinite(p.v); })
            .sort(function (a, b) { return a.ts - b.ts; });
        var n = s.length;
        var res = { events: [], ref: 0, n: n, speedKnown: false };
        if (n < (o.minSamples || 5)) { return res; }

        var v = s.map(function (p) { return p.v; });
        for (var k = 1; k < n - 1; k++) {
            var a = s[k - 1].v, b = s[k].v, c = s[k + 1].v;
            v[k] = a + b + c - Math.max(a, b, c) - Math.min(a, b, c);
        }
        var ref = Math.max(o.capacityHint || 0, Math.max.apply(null, v));
        if (!(ref > 0)) { return res; }
        res.ref = ref;

        var stop = o.stopSpeedKmh == null ? 3 : o.stopSpeedKmh;
        var moving = s.map(function (p) { return p.spd != null && p.spd > stop; });
        res.speedKnown = s.some(function (p) { return p.spd != null; });
        var windowSec = (o.windowMin || 30) * 60;
        var maxGapSec = (o.maxGapMin || 360) * 60;

        var median3 = function (arr) {
            var t = arr.slice().sort(function (x, y) { return x - y; });
            return t[Math.floor(t.length / 2)];
        };

        // sign +1 busca cargas (alza), -1 drenajes (baja).
        var scan = function (sign, minPct) {
            var thr = minPct / 100 * ref;
            var i = 0, lastEv = null;
            while (i < n - 1) {
                if (moving[i]) { i++; continue; }
                var bestJ = -1, bestD = 0;
                for (var j = i + 1; j < n; j++) {
                    if (moving[j]) { break; }
                    var span = s[j].ts - s[i].ts;
                    var pairGap = j === i + 1 && (s[j].ts - s[i].ts) <= maxGapSec;
                    if (span > windowSec && !(sign > 0 && pairGap)) { break; }
                    var d = sign * (v[j] - v[i]);
                    if (d > bestD) { bestD = d; bestJ = j; }
                }
                if (bestJ > 0 && bestD >= thr) {
                    var after = median3(v.slice(bestJ, Math.min(n, bestJ + 3)));
                    if (sign * (after - v[i]) >= 0.7 * thr) {
                        // Una carga lenta o un drenaje escalonado se parte en
                        // varios tramos por la ventana: si este empieza donde
                        // terminó el anterior del mismo tipo, se fusionan.
                        var prev = lastEv;
                        if (prev && s[i].ts - prev.te <= windowSec) {
                            prev.te = s[bestJ].ts; prev.to = v[bestJ]; prev.delta = prev.to - prev.from;
                            prev.pct = Math.abs(prev.delta) / ref * 100;
                            prev.viaGap = prev.viaGap || (s[bestJ].ts - s[i].ts) > windowSec;
                            i = bestJ + 1;
                            continue;
                        }
                        lastEv = {
                            kind: sign > 0 ? 'carga' : 'drenaje',
                            ts: s[i].ts, te: s[bestJ].ts,
                            from: v[i], to: v[bestJ], delta: v[bestJ] - v[i],
                            pct: bestD / ref * 100,
                            viaGap: (s[bestJ].ts - s[i].ts) > windowSec,
                            speedKnown: res.speedKnown
                        };
                        res.events.push(lastEv);
                        i = bestJ + 1;
                        continue;
                    }
                }
                i++;
            }
        };
        scan(1, o.loadMinPct || 10);
        scan(-1, o.drainMinPct || 6);
        res.events.sort(function (x, y) { return x.ts - y.ts; });
        return res;
    },

    /** ts en segundos si el número parece un timestamp Unix (s o ms), si no null. */
    _fuelTs: function (x) {
        var n = Number(x);
        if (!isFinite(n)) { return null; }
        if (n >= 1e9 && n < 4e9) { return n; }
        if (n >= 1e12 && n < 4e12) { return Math.floor(n / 1000); }
        return null;
    },

    /**
     * Interpreta un arreglo como serie de muestras si TODAS las primeras
     * (hasta 5) lo parecen: [ts, valor(, velocidad)] u objeto con una clave
     * de tiempo y una de valor. null si no es una serie.
     */
    _asFuelSamples: function (arr) {
        var me = this;
        if (!Array.isArray(arr) || arr.length < 2) { return null; }
        var tsKeys = ['ts', 'time', 't', 'unixtimestamp', 'timestamp', 'dt'];
        var vKeys = ['value', 'val', 'v', 'fuel', 'level', 'liters', 'litres', 'l'];
        var sKeys = ['speed', 'spd', 's'];
        var pick = function (o, keys) {
            for (var i = 0; i < keys.length; i++) {
                if (o[keys[i]] != null && o[keys[i]] !== '') { return o[keys[i]]; }
            }
            return undefined;
        };
        var one = function (el) {
            var ts, val, spd;
            if (Array.isArray(el)) {
                ts = el[0]; val = el[1]; spd = el.length > 2 ? el[2] : null;
            } else if (el && typeof el === 'object') {
                ts = pick(el, tsKeys); val = pick(el, vKeys); spd = pick(el, sKeys);
            } else { return null; }
            var t = me._fuelTs(ts);
            if (t == null || val == null || val === '' || !isFinite(Number(val))) { return null; }
            var sp = (spd == null || spd === '' || !isFinite(Number(spd))) ? null : Number(spd);
            return { ts: t, v: Number(val), spd: sp };
        };
        for (var i = 0; i < Math.min(arr.length, 5); i++) {
            if (!one(arr[i])) { return null; }
        }
        var out = [];
        for (var j = 0; j < arr.length; j++) {
            var p = one(arr[j]);
            if (p) { out.push(p); }
        }
        return out;
    },

    /** Serie en forma de mapa { "<ts>": valor }, o null. */
    _asFuelSamplesFromMap: function (obj) {
        var keys = Object.keys(obj);
        if (keys.length < 2) { return null; }
        for (var i = 0; i < Math.min(keys.length, 5); i++) {
            if (this._fuelTs(keys[i]) == null || obj[keys[i]] == null || !isFinite(Number(obj[keys[i]]))) { return null; }
        }
        var out = [];
        for (var j = 0; j < keys.length; j++) {
            var t = this._fuelTs(keys[j]);
            if (t != null && isFinite(Number(obj[keys[j]]))) { out.push({ ts: t, v: Number(obj[keys[j]]), spd: null }); }
        }
        return out;
    },

    /** Recorre la respuesta y junta todo lo que parezca una serie temporal. */
    _collectFuelSeries: function (node, path, out, depth) {
        if (depth > 8 || node == null || typeof node !== 'object') { return; }
        var me = this;
        var smp = Array.isArray(node) ? me._asFuelSamples(node) : me._asFuelSamplesFromMap(node);
        if (smp) { out.push({ path: path, samples: smp }); return; }
        Object.keys(node).forEach(function (k) {
            me._collectFuelSeries(node[k], path.concat(k), out, depth + 1);
        });
    },

    /**
     * Interpreta la respuesta de reports.php report_type=16 para UN vehículo.
     * Esquema no confirmado: se buscan series [ts, valor(, velocidad)] en
     * cualquier parte de `data`; una serie cuya ruta menciona "speed" es la
     * velocidad y se cruza por tiempo con la serie de nivel. Si hay varias
     * series de nivel se prefiere la que menciona combustible y, si no, la
     * más larga.
     *
     * @return {{status:string, samples?:Array, sensor?:string}} status: 'ok',
     *   'nosensor' (el reporte avisa que no hay sensor), 'nodata' (hay sensor
     *   pero ninguna muestra en la ventana) o 'unrecognized'.
     */
    _parseFuelReport: function (resp) {
        if (!resp || typeof resp !== 'object') { return { status: 'unrecognized' }; }
        var txt = '';
        try { txt = JSON.stringify(resp); } catch (e) { txt = ''; }
        // El reporte de líquidos avisa con este texto cuando el objeto no
        // tiene sensor; se asume el mismo criterio acá. Solo se mira en
        // respuestas chicas para no confundir un dato largo con un aviso.
        if (txt.length < 800 && /no\s+(fuel\s+)?sensors?|sin\s+sensor/i.test(txt)) { return { status: 'nosensor' }; }

        var found = [];
        this._collectFuelSeries(resp.data !== undefined ? resp.data : resp, [], found, 0);
        var isSpeed = function (c) { return c.path.some(function (k) { return /speed|veloc|spd/i.test(k); }); };
        var levels = found.filter(function (c) { return !isSpeed(c); });
        var speeds = found.filter(isSpeed);

        if (!levels.length) {
            // Vacío en cualquier profundidad ({}, [], {"level1": []}): hay
            // sensor pero ninguna muestra en la ventana.
            var isEmpty = function (x) {
                if (x == null) { return true; }
                if (typeof x !== 'object') { return false; }
                return Object.keys(x).every(function (k) { return isEmpty(x[k]); });
            };
            var empty = isEmpty(resp.data);
            return { status: (resp.success !== false && empty) ? 'nodata' : 'unrecognized' };
        }
        var fuelRe = /fuel|combust|level|litr|nivel/i;
        levels.sort(function (a, b) {
            var fa = a.path.some(function (k) { return fuelRe.test(k); }) ? 1 : 0;
            var fb = b.path.some(function (k) { return fuelRe.test(k); }) ? 1 : 0;
            return (fb - fa) || (b.samples.length - a.samples.length);
        });
        var best = levels[0];
        var samples = best.samples.map(function (p) { return { ts: p.ts, v: p.v, spd: p.spd }; });

        // Velocidad en serie aparte: se toma la muestra más cercana (<= 5 min).
        if (speeds.length && !samples.some(function (p) { return p.spd != null; })) {
            var sp = speeds.sort(function (a, b) { return b.samples.length - a.samples.length; })[0].samples;
            sp = sp.slice().sort(function (a, b) { return a.ts - b.ts; });
            var q = 0;
            samples.sort(function (a, b) { return a.ts - b.ts; });
            for (var i = 0; i < samples.length; i++) {
                while (q + 1 < sp.length && Math.abs(sp[q + 1].ts - samples[i].ts) <= Math.abs(sp[q].ts - samples[i].ts)) { q++; }
                if (sp[q] && Math.abs(sp[q].ts - samples[i].ts) <= 300) { samples[i].spd = sp[q].v; }
            }
        }
        return { status: 'ok', samples: samples, sensor: best.path[best.path.length - 1] || '' };
    },

    /**
     * Extrae los sensores de la respuesta de routeBuilder.php
     * (get_bind_routes_to_agents): objetos con `semanticid` y `agent_id` en
     * cualquier parte. Devuelve [{agentId, semanticid}].
     */
    _parseSensorCatalog: function (resp) {
        var out = [];
        var walk = function (node, depth) {
            if (depth > 6 || node == null || typeof node !== 'object') { return; }
            if (!Array.isArray(node) && node.semanticid != null && node.agent_id != null) {
                out.push({ agentId: Number(node.agent_id), semanticid: Number(node.semanticid) });
                return;
            }
            Object.keys(node).forEach(function (k) { walk(node[k], depth + 1); });
        };
        walk(resp, 0);
        return out;
    },

    _sleep: function (ms) {
        return new Promise(function (resolve) { setTimeout(resolve, ms); });
    },

    /**
     * Cataloga qué vehículos tienen sensor de combustible (semanticid 2)
     * consultando la lista de sensores por vehículo, en lotes chicos con
     * pausa. El catálogo se cachea en memoria y en localStorage (la config de
     * sensores casi no cambia). Solo lectura.
     *
     * Devuelve { ids, mode }: mode 'catalog' si el catálogo respondió con un
     * formato reconocido; 'probe' si no (el llamador prueba el reporte 16
     * sobre una muestra acotada de vehículos).
     */
    _fuelSensorVehicles: function (vehIds, cfg) {
        var me = this;
        if (cfg.agentIds && cfg.agentIds.length) {
            var inScope = {};
            vehIds.forEach(function (id) { inScope[id] = 1; });
            return Promise.resolve({ ids: cfg.agentIds.map(Number).filter(function (id) { return inScope[id]; }), mode: 'config' });
        }

        var KEY = 'promatic_dashboard_enhancer_fuel_catalog';
        var ttl = (cfg.catalogCacheHours || 24) * 3600000;
        var cat = me._fuelCatalog;
        if (!cat) {
            try {
                var raw = window.localStorage && JSON.parse(localStorage.getItem(KEY) || 'null');
                if (raw && raw.at && Date.now() - raw.at < ttl && raw.known) { cat = raw; }
            } catch (e) { /* storage bloqueado o corrupto */ }
        }
        cat = cat || { at: Date.now(), known: {} };
        me._fuelCatalog = cat;

        var pending = vehIds.filter(function (id) { return cat.known[id] === undefined; });
        var batches = [];
        for (var i = 0; i < pending.length; i += cfg.catalogBatch) { batches.push(pending.slice(i, i + cfg.catalogBatch)); }

        var failed = false;
        var seq = Promise.resolve();
        batches.forEach(function (ids, bi) {
            seq = seq.then(function () {
                if (failed) { return null; }
                return (bi ? me._sleep(cfg.pauseMs) : Promise.resolve()).then(function () {
                    var url = '/backend/ax/mod/routeBuilder.php?cmd=get_bind_routes_to_agents&agents_ids=' +
                        encodeURIComponent('[' + ids.join(',') + ']') + '&page=1&start=0&limit=5000';
                    return fetch(url, { credentials: 'include' });
                }).then(function (resp) {
                    if (!resp.ok) { throw new Error('HTTP ' + resp.status); }
                    return resp.json();
                }).then(function (data) {
                    var sensors = me._parseSensorCatalog(data);
                    Store.promatic_dashboard_enhancer.Module.debugLog('combustible: catálogo de sensores, lote ' + (bi + 1) + '/' + batches.length +
                        ': ' + ids.length + ' vehículos, ' + sensors.length + ' sensores', bi === 0 ? data : '');
                    var seen = {};
                    sensors.forEach(function (sn) { seen[sn.agentId] = 1; });
                    // Un lote de varios vehículos que responde por uno solo
                    // indica que el endpoint no acepta una lista: el
                    // catálogo no es confiable y se pasa a sondeo directo.
                    if (!sensors.length || (ids.length >= 5 && Object.keys(seen).length === 1)) { failed = true; return; }
                    ids.forEach(function (id) { cat.known[id] = 0; });
                    sensors.forEach(function (sn) {
                        if (sn.semanticid === 2) { cat.known[sn.agentId] = 1; }
                    });
                    // Se guarda lote a lote: si la sesión se cae o se recarga
                    // la página a mitad de un escaneo de ~1400 vehículos, el
                    // siguiente arranque retoma donde quedó.
                    try { localStorage.setItem(KEY, JSON.stringify(cat)); } catch (e) { /* storage bloqueado */ }
                });
            }).catch(function (err) {
                failed = true;
                console.warn('[promatic_dashboard_enhancer] catálogo de sensores de combustible no disponible:', err);
            });
        });

        return seq.then(function () {
            if (failed) { return { ids: [], mode: 'probe' }; }
            cat.at = cat.at || Date.now();
            try { localStorage.setItem(KEY, JSON.stringify(cat)); } catch (e) { /* storage bloqueado */ }
            return { ids: vehIds.filter(function (id) { return cat.known[id] === 1; }), mode: 'catalog' };
        });
    },

    /**
     * Carga las alertas de combustible sin bloquear el resto de las
     * tarjetas: la tarjeta pasa por "cargando", y al terminar se vuelve a
     * dibujar. Respeta el caché (cacheMinutes por vehículo) para que los
     * refrescos frecuentes del dashboard no repitan las consultas, y limita
     * cada ciclo a maxVehicles consultas nuevas: con flotas grandes la
     * cobertura se completa de a poco en los ciclos siguientes.
     *
     * Estado resultante en this._fuel (ver _fuelSummary).
     */
    loadFuelAlerts: function (vehIds) {
        var me = this;
        var cfg = me._fuelCfg();
        if (!cfg.enabled || !vehIds || !vehIds.length || me._fuelRunning) { return; }
        me._fuelRunning = true;
        me._fuelPerVeh = me._fuelPerVeh || {};
        var dbg = Store.promatic_dashboard_enhancer.Module.debugLog.bind(Store.promatic_dashboard_enhancer.Module);
        var breakerKey = 'reports.php:report_type=16';
        var ttl = cfg.cacheMinutes * 60000;
        var now = Date.now();

        var finish = function (extra) {
            me._fuelRunning = false;
            me._fuel = Ext.apply(me._fuelAggregate(vehIds, cfg), extra || {});
            dbg('combustible: estado=' + me._fuel.state + ' modo=' + me._fuel.mode + ' ok=' + me._fuel.counts.ok +
                ' sin_sensor=' + me._fuel.counts.nosensor + ' sin_datos=' + me._fuel.counts.nodata +
                ' no_reconocido=' + me._fuel.counts.unrecognized + ' error=' + me._fuel.counts.error +
                ' cargas=' + me._fuel.loadIds.length + ' drenajes=' + me._fuel.drainIds.length);
            me.renderAlertasGenerales();
        };

        if (me._isEndpointBlocked(breakerKey)) { me._fuelRunning = false; return; }

        me._fuelSensorVehicles(vehIds, cfg).then(function (src) {
            var candidates = src.mode === 'probe'
                ? vehIds.slice(0, cfg.maxVehicles * 2)
                : src.ids;
            var todo = candidates.filter(function (id) {
                var c = me._fuelPerVeh[id];
                return !c || now - c.at > ttl;
            }).slice(0, cfg.maxVehicles);

            var stop = new Date();
            stop.setDate(stop.getDate() + 1);
            var start = new Date();
            start.setDate(start.getDate() - cfg.windowDays);
            var rawLogged = 0;

            var runOne = function (id) {
                return me.fetchReportType(16, String(id), start, stop, 30000).then(function (resp) {
                    if (rawLogged < cfg.debugRawMax) {
                        rawLogged++;
                        dbg('combustible report_type=16 crudo (agent ' + id + '):', resp);
                    }
                    var parsed = me._parseFuelReport(resp);
                    var entry = { at: Date.now(), status: parsed.status, events: [], n: 0, sensor: parsed.sensor || '', ref: 0, speedKnown: false };
                    if (parsed.status === 'ok') {
                        var det = me._detectFuelEvents(parsed.samples, cfg);
                        entry.events = det.events; entry.n = det.n; entry.ref = det.ref; entry.speedKnown = det.speedKnown;
                        if (det.n < cfg.minSamples) { entry.status = 'nodata'; }
                    }
                    me._fuelPerVeh[id] = entry;
                }).catch(function (err) {
                    if (err && /HTTP 401/.test(err.message || '')) { me._markEndpointBlocked(breakerKey); }
                    me.widgetErrorCode('FUEL-16', err, 'agent ' + id);
                    me._fuelPerVeh[id] = { at: Date.now(), status: 'error', events: [], n: 0 };
                });
            };

            // Lotes chicos y secuenciales, con pausa: nunca ráfagas contra
            // PILOT (ya cerró sesiones por exceso de consultas simultáneas).
            var seq = Promise.resolve();
            for (var b = 0; b < todo.length; b += cfg.batchSize) {
                (function (slice, first) {
                    seq = seq.then(function () {
                        if (me._isEndpointBlocked(breakerKey)) { return null; }
                        return (first ? Promise.resolve() : me._sleep(cfg.pauseMs))
                            .then(function () { return Promise.all(slice.map(runOne)); });
                    });
                })(todo.slice(b, b + cfg.batchSize), b === 0);
            }
            return seq.then(function () {
                var extra = { mode: src.mode, sensorCount: src.mode === 'probe' ? null : src.ids.length };
                // Catálogo o lista explícita sin ningún vehículo con sensor:
                // es "sin sensor" (N/D), no "sin datos".
                if (src.mode !== 'probe' && !src.ids.length) { extra.state = 'nosensor'; }
                finish(extra);
            });
        }).catch(function (err) {
            me.widgetErrorCode('FUEL-ALERT', err);
            me._fuelRunning = false;
            me._fuel = { state: 'error', counts: { ok: 0, nosensor: 0, nodata: 0, unrecognized: 0, error: 0 }, loadIds: [], drainIds: [], scopeTotal: vehIds.length, mode: '' };
            me.renderAlertasGenerales();
        });
    },

    /**
     * Agrega los resultados por vehículo (this._fuelPerVeh) de los vehículos
     * en alcance.
     * state: 'ok' (hay al menos un vehículo analizado), 'unrecognized' (el
     * reporte respondió pero no se reconoció su formato), 'nosensor' (ningún
     * vehículo con sensor), 'nodata' (con sensor pero sin muestras) o 'error'.
     */
    _fuelAggregate: function (vehIds, cfg) {
        var me = this;
        var counts = { ok: 0, nosensor: 0, nodata: 0, unrecognized: 0, error: 0 };
        var loadIds = [], drainIds = [], loadEvents = 0, drainEvents = 0, analyzed = 0;
        vehIds.forEach(function (id) {
            var c = me._fuelPerVeh[id];
            if (!c) { return; }
            counts[c.status] = (counts[c.status] || 0) + 1;
            if (c.status !== 'ok') { return; }
            analyzed++;
            var ld = c.events.filter(function (e) { return e.kind === 'carga'; }).length;
            var dr = c.events.length - ld;
            if (ld) { loadIds.push(id); loadEvents += ld; }
            if (dr) { drainIds.push(id); drainEvents += dr; }
        });
        var state = 'nodata';
        if (counts.ok) { state = 'ok'; }
        else if (counts.unrecognized) { state = 'unrecognized'; }
        else if (counts.error && !counts.nosensor && !counts.nodata) { state = 'error'; }
        else if (counts.nosensor && !counts.nodata) { state = 'nosensor'; }
        return {
            state: state, counts: counts, analyzed: analyzed,
            loadIds: loadIds, drainIds: drainIds, loadEvents: loadEvents, drainEvents: drainEvents,
            scopeTotal: vehIds.length, windowDays: cfg.windowDays, at: Date.now()
        };
    },

    /**
     * Resumen para tarjetas, reportes y exportador. `kind`: 'carga' o
     * 'drenaje'. count es número solo si hay datos reales (state 'ok');
     * `cov` es el texto de cobertura ("N de M con sensor").
     * @return {{state:string, count:(number|null), cov:string, ids:Array}}
     */
    _fuelSummary: function (kind) {
        var f = this._fuel;
        if (!f) {
            return { state: this._fuelRunning ? 'loading' : 'none', count: null, cov: '', ids: [] };
        }
        // Con catálogo, "con sensor" es el total catalogado; en sondeo, solo
        // los vehículos que respondieron con sensor.
        var withSensor = f.sensorCount != null ? f.sensorCount : f.counts.ok + f.counts.nodata + f.counts.unrecognized;
        var cov = l('posible') + ' · ' + withSensor + ' ' + l('de') + ' ' + f.scopeTotal + ' ' + l('con sensor');
        var ids = kind === 'carga' ? (f.loadIds || []) : (f.drainIds || []);
        return {
            state: f.state, withSensor: withSensor, analyzed: f.counts.ok, cov: cov, ids: ids,
            count: f.state === 'ok' ? ids.length : null
        };
    },

    /**
     * Detalle de posibles cargas ('carga') o drenajes ('drenaje') de
     * combustible: 1 fila por evento, con ficha del vehículo y posición
     * actual (online_tree), más la cobertura por estado del sensor.
     */
    buildFuelAlertsReport: function (kind) {
        var me = this;
        var esc = Ext.String.htmlEncode;
        var isLoad = kind === 'carga';
        var f = this._fuel || { counts: {}, scopeTotal: 0 };
        var cfg = this._fuelCfg();
        var title = isLoad ? l('Detalle Posibles Inconsistencias en Carga') : l('Detalle Posible Drenaje de Combustible');
        var byId = this._onlineRecordsByAgent();
        var nameById = {};
        Object.keys(byId).forEach(function (id) { nameById[id] = byId[id].get('name'); });

        var events = [];
        Object.keys(this._fuelPerVeh || {}).forEach(function (id) {
            var c = me._fuelPerVeh[id];
            if (!c || c.status !== 'ok') { return; }
            c.events.forEach(function (e) {
                if (e.kind === kind) { events.push({ id: Number(id), e: e, ref: c.ref }); }
            });
        });
        events.sort(function (a, b) { return b.e.ts - a.e.ts; });
        var shown = events.slice(0, 300);

        var rowHtml = function (x) {
            var rec = byId[x.id];
            var name = rec ? rec.get('name') : String(x.id);
            var cur = rec ? me._recordLatLon(rec) : null;
            var sheet = me._vehicleSheetLines(rec).map(esc).join('<br>') || l('N/D');
            var curCell = cur
                ? '<button type="button" class="promatic_dashboard_enhancer-focus-btn" data-focus-lat="' + cur[0] +
                  '" data-focus-lon="' + cur[1] + '" data-focus-label="' + esc(me.displayName(name) + ' — ' + l('posición actual')) +
                  '">' + l('ver posición actual') + '</button><br>' + cur[0].toFixed(5) + ', ' + cur[1].toFixed(5)
                : l('N/D');
            var e = x.e;
            var conf = (e.speedKnown ? '' : l('sin dato de velocidad (confianza baja)')) +
                (e.viaGap ? (e.speedKnown ? '' : '<br>') + l('el equipo no reportó entre ambas lecturas') : '');
            return '<tr><td>' + esc(me._fmtEventDateTime(e.ts)) + (e.te !== e.ts ? ' → ' + esc(me._fmtEventDateTime(e.te)) : '') +
                '</td><td>' + esc(me.displayName(name)) + '</td><td>' + sheet + '</td><td class="n">' +
                e.from.toFixed(1) + ' → ' + e.to.toFixed(1) + '<br>(' + (e.delta > 0 ? '+' : '') + e.delta.toFixed(1) + ' · ' + e.pct.toFixed(0) + '% ' + l('del máximo') +
                ')</td><td>' + (conf || l('vehículo detenido')) + '</td><td>' + curCell + '</td></tr>';
        };

        var body;
        if (f.state === 'unrecognized') {
            body = '<p>' + l('El reporte de sensor de combustible respondió, pero su formato aún no se reconoce: función en desarrollo. Activa el modo de depuración para volcar la respuesta cruda a la consola.') + '</p>';
        } else if (!shown.length) {
            body = '<p>' + (f.state === 'ok'
                ? l('Ningún vehículo con sensor muestra un evento posible en la ventana analizada.')
                : l('Sin datos de sensor de combustible para mostrar.')) + '</p>';
        } else {
            body = '<table id="promatic_dashboard_enhancer-fuel-table"><tr><th>' + l('Fecha y hora') + '</th><th>' + l('Vehículo') +
                '</th><th>' + l('Ficha') + '</th><th>' + l('Nivel (unidad del sensor)') + '</th><th>' + l('Condición') +
                '</th><th>' + l('Posición actual') + '</th></tr>';
            for (var i = 0; i < shown.length; i++) { body += rowHtml(shown[i]); }
            body += '</table>';
            if (events.length > shown.length) { body += '<p class="sub">' + l('Se muestran los 300 más recientes de') + ' ' + events.length + '.</p>'; }
        }

        var c = f.counts || {};
        var cover = '<table><tr><th>' + l('Cobertura') + '</th><th>' + l('Vehículos') + '</th></tr>' +
            (f.sensorCount != null ? '<tr><td>' + l('Con sensor de combustible (catálogo)') + '</td><td class="n">' + f.sensorCount + '</td></tr>' : '') +
            '<tr><td>' + l('Analizados con sensor') + '</td><td class="n">' + (c.ok || 0) + '</td></tr>' +
            '<tr><td>' + l('Con sensor, sin muestras en la ventana') + '</td><td class="n">' + (c.nodata || 0) + '</td></tr>' +
            '<tr><td>' + l('Sin sensor de combustible (N/D)') + '</td><td class="n">' + (c.nosensor || 0) + '</td></tr>' +
            '<tr><td>' + l('Respuesta no reconocida / error') + '</td><td class="n">' + ((c.unrecognized || 0) + (c.error || 0)) + '</td></tr>' +
            '<tr><td>' + l('Vehículos en el alcance') + '</td><td class="n">' + (f.scopeTotal || 0) + '</td></tr></table>';

        var desc = '<p class="desc">' + (isLoad
            ? l('Posibles cargas de combustible: alzas de nivel con el vehículo detenido, calculadas por el Dashboard sobre la serie del sensor. Son indicios, no hechos: confirma con la tarjeta de combustible o el conductor.')
            : l('Posibles drenajes de combustible: bajas bruscas de nivel con el vehículo detenido, calculadas por el Dashboard sobre la serie del sensor. Son indicios, no hechos: un sensor con ruido o un estanque en pendiente pueden imitarlos.')) +
            '</p><p class="desc">' + l('Umbral: variación mínima de') + ' ' + (isLoad ? cfg.loadMinPct : cfg.drainMinPct) + '% ' +
            l('del nivel máximo observado; ventana de') + ' ' + cfg.windowDays + ' ' + l('días. Fuente: reports.php report_type=16.') + '</p>';

        return '<!doctype html><html><head><meta charset="utf-8"><title>' + title +
            '</title>' + this._reportStyles() + '</head><body>' +
            this._reportHeader(title, cfg.windowDays) + desc + body +
            '<h2>' + l('Cobertura de sensores') + '</h2>' + cover +
            '<div class="foot">' + l('Reporte generado por el Dashboard sobre datos de PILOT Telematics. La configuración de sensores es por vehículo: "sin sensor" no es lo mismo que "sin eventos".') +
            '</div>' + this._modalActionsScript() + '</body></html>';
    },

    buildFuelAlertsPdfDoc: function (kind) {
        var me = this;
        var isLoad = kind === 'carga';
        var f = this._fuel || { counts: {}, scopeTotal: 0 };
        var cfg = this._fuelCfg();
        var doc = this._pdfBase(isLoad ? l('Detalle Posibles Inconsistencias en Carga') : l('Detalle Posible Drenaje de Combustible'),
            this._pdfRange(cfg.windowDays));
        var C = doc.content;
        var byId = this._onlineRecordsByAgent();
        C.push({ text: (isLoad
            ? l('Posibles cargas: alzas de nivel con el vehículo detenido, calculadas sobre la serie del sensor (report_type=16). Son indicios, no hechos.')
            : l('Posibles drenajes: bajas bruscas de nivel con el vehículo detenido, calculadas sobre la serie del sensor (report_type=16). Son indicios, no hechos.')), style: 'desc' });

        var rows = [];
        Object.keys(this._fuelPerVeh || {}).forEach(function (id) {
            var c = me._fuelPerVeh[id];
            if (!c || c.status !== 'ok') { return; }
            c.events.forEach(function (e) {
                if (e.kind !== kind) { return; }
                var rec = byId[id];
                rows.push([e.ts, [me._fmtEventDateTime(e.ts), me.displayName(rec ? rec.get('name') : String(id)),
                    me._vehicleSheetLines(rec).join('\n') || l('N/D'),
                    e.from.toFixed(1) + ' → ' + e.to.toFixed(1) + ' (' + (e.delta > 0 ? '+' : '') + e.delta.toFixed(1) + ', ' + e.pct.toFixed(0) + '%)',
                    e.speedKnown ? l('vehículo detenido') : l('sin dato de velocidad')]]);
            });
        });
        rows.sort(function (a, b) { return b[0] - a[0]; });
        if (f.state === 'unrecognized') {
            C.push({ text: l('Formato del reporte de sensor aún no reconocido: función en desarrollo.') });
        } else if (!rows.length) {
            C.push({ text: l('Ningún vehículo con sensor muestra un evento posible en la ventana analizada.') });
        } else {
            C.push(this._pdfTable([l('Fecha y hora'), l('Vehículo'), l('Ficha'), l('Nivel (unidad del sensor)'), l('Condición')],
                rows.slice(0, 300).map(function (r) { return r[1]; })));
        }
        var c = f.counts || {};
        C.push({ text: l('Cobertura de sensores'), style: 'h2' });
        C.push(this._pdfTable([l('Cobertura'), l('Vehículos')], [
            [l('Analizados con sensor'), { text: String(c.ok || 0), alignment: 'right' }],
            [l('Con sensor, sin muestras en la ventana'), { text: String(c.nodata || 0), alignment: 'right' }],
            [l('Sin sensor de combustible (N/D)'), { text: String(c.nosensor || 0), alignment: 'right' }],
            [l('Respuesta no reconocida / error'), { text: String((c.unrecognized || 0) + (c.error || 0)), alignment: 'right' }],
            [l('Vehículos en el alcance'), { text: String(f.scopeTotal || 0), alignment: 'right' }]
        ]));
        C.push({ text: l('Reporte generado por el Dashboard sobre datos de PILOT Telematics.'), style: 'foot' });
        return doc;
    },

    /** Abre el modal de detalle de combustible; el mapa muestra la posición actual de los vehículos con eventos. */
    openFuelAlertModal: function (kind) {
        var me = this;
        var byId = this._onlineRecordsByAgent();
        var s = this._fuelSummary(kind);
        var points = [];
        s.ids.forEach(function (id) {
            var rec = byId[id];
            var cur = rec ? me._recordLatLon(rec) : null;
            if (cur) { points.push({ lat: cur[0], lon: cur[1], label: me.displayName(rec.get('name')) }); }
        });
        var title = kind === 'carga' ? l('Detalle Posibles Inconsistencias en Carga') : l('Detalle Posible Drenaje de Combustible');
        me.openReportModal(me.buildFuelAlertsReport(kind), title,
            me._safe(function () { return me.buildFuelAlertsPdfDoc(kind); }),
            points, { notice: points.length ? l('Mostrando la posición actual de los vehículos con eventos posibles') : '' });
    },

    renderAlertasGenerales: function () {
        var accidentes = this._alertAccidentes;
        var mantencion = this._alertMantencion;
        var ralenti = this._alertRalenti;
        // Íconos de Accidentes/Mantención dibujados a mano (outline, viewBox
        // 24x24, stroke=currentColor). El resto son assets de dev/icons/
        // copiados inline para heredar el color de cada card sin request HTTP
        // extra.
        var svgAccidente =
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" ' +
            'stroke-linecap="round" stroke-linejoin="round">' +
            '<path d="M12 3 L21.5 20 H2.5 Z" /><line x1="12" y1="9" x2="12" y2="14" />' +
            '<circle cx="12" cy="17" r="1.1" fill="currentColor" stroke="none" /></svg>';
        var svgMantencion =
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" ' +
            'stroke-linecap="round" stroke-linejoin="round">' +
            '<path d="M14.7 6.3a4 4 0 0 0-5.3 5.3L4 17l3 3 5.4-5.4a4 4 0 0 0 5.3-5.3l-2.6 2.6-2.1-2.1z" />' +
            '<path d="M7 17h.01" /></svg>';

        var svgRalenti =
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 217.13 206.37"><defs><style>.cls-1{fill:#fff;}</style></defs><g id="Capa_2" data-name="Capa 2"><g id="Capa_1-2" data-name="Capa 1"><rect class="cls-1" x="105.99" y="174.49" width="27.15" height="5.53" transform="translate(-93.29 157.06) rotate(-50.58)"/><path class="cls-1" d="M141.3,139a8.13,8.13,0,0,0-11.82,0q-2.05,2.57-2.06,7.51v4.35c0,3.17.73,5.6,2.1,7.3a8.09,8.09,0,0,0,11.84-.05q2-2.59,2-7.49V146.3Q143.35,141.54,141.3,139Zm-2.6,12.48a9,9,0,0,1-.79,4.13,2.64,2.64,0,0,1-2.49,1.35,2.67,2.67,0,0,1-2.52-1.41,9.08,9.08,0,0,1-.79-4.29v-5.75a8.12,8.12,0,0,1,.84-4,2.66,2.66,0,0,1,2.44-1.27,2.71,2.71,0,0,1,2.51,1.34,8.71,8.71,0,0,1,.8,4.28Z"/><path class="cls-1" d="M96,70.86l-9.79,3.51v3.81l5.6-1.74V94.52h4.69V70.86Z"/><rect class="cls-1" x="52.53" y="86.68" width="27.14" height="5.52" transform="translate(-16.44 14.9) rotate(-11.45)"/><rect class="cls-1" x="105.99" y="174.49" width="27.15" height="5.53" transform="translate(-93.28 156.93) rotate(-50.55)"/><rect class="cls-1" x="69.09" y="135.47" width="27.13" height="2" transform="translate(-60.78 66.58) rotate(-32.82)"/><rect class="cls-1" x="63.36" y="19.9" width="2" height="27.13" transform="translate(18.07 89.32) rotate(-77.82)"/><path class="cls-1" d="M0,0V206.37H217.13V0ZM211.13,48.17l-.17,0c-9.53,2.51-15.49,10.57-14.72,19L103.86,92.29l2.35,6.79,92.2-25a20.2,20.2,0,0,0,12.72,9.3v92.88C192.66,190.62,170.28,199,146.19,199,83,199,31.52,141,31.52,69.75a141.31,141.31,0,0,1,15.09-64H211.13Z"/></g></g></svg>';
        var svgCombustible =
            '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">' +
            '<path fill="currentColor" d="m19.77 7.23l.01-.01l-3.72-3.72L15 4.56l2.11 2.11c-.94.36-1.61 1.26-1.61 2.33a2.5 2.5 0 0 0 2.5 2.5c.36 0 .69-.08 1-.21v7.21c0 .55-.45 1-1 1s-1-.45-1-1V14c0-1.1-.9-2-2-2h-1V5c0-1.1-.9-2-2-2H6c-1.1 0-2 .9-2 2v16h10v-7.5h1.5v5a2.5 2.5 0 0 0 5 0V9c0-.69-.28-1.32-.73-1.77M12 10H6V5h6zm6 0c-.55 0-1-.45-1-1s.45-1 1-1s1 .45 1 1s-.45 1-1 1"/></svg>';
        // Ícono de GPS desconectado manual: manipulación física del
        // dispositivo (desenchufar/jammer). No confundir con el de "Sin Señal
        // GPS" (antena tachada, watermark de la card gps_signal).
        var svgGpsManual =
            '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 48 48">' +
            '<path fill="currentColor" d="M25.6,25.6,22.2,29,19,25.8l3.4-3.4a2,2,0,0,0-2.8-2.8L16.2,23l-1.3-1.3a1.9,1.9,0,0,0-2.8,0l-3,3a9.8,9.8,0,0,0-3,7,9.1,9.1,0,0,0,1.8,5.6L4.6,40.6a1.9,1.9,0,0,0,0,2.8,1.9,1.9,0,0,0,2.8,0l3.2-3.2a10.1,10.1,0,0,0,5.9,1.9,10.2,10.2,0,0,0,7.1-2.9l3-3a2,2,0,0,0,.6-1.4,1.7,1.7,0,0,0-.6-1.4L25,31.8l3.4-3.4a2,2,0,0,0-2.8-2.8Z"/>' +
            '<path fill="currentColor" d="M43.4,4.6a1.9,1.9,0,0,0-2.8,0L37.2,8a10,10,0,0,0-13,.9l-3,3a2,2,0,0,0-.6,1.4,1.7,1.7,0,0,0,.6,1.4L32.9,26.4a1.9,1.9,0,0,0,2.8,0l3-2.9a9.9,9.9,0,0,0,2.9-7.1A10.4,10.4,0,0,0,40,10.9l3.4-3.5A1.9,1.9,0,0,0,43.4,4.6Z"/></svg>';
        var svgTerritorio =
            '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 1024 1023">' +
            '<path fill="currentColor" d="M512 1023q-104 0-199-40.5t-163.5-109T40.5 710T0 511t40.5-198.5t109-163T313 40.5T512 0t199 40.5t163.5 109t109 163T1024 511t-40.5 199t-109 163.5t-163.5 109t-199 40.5m222-199L512 602L290 824q100 71 222 71t222-71M128 511q0 122 70 221l222-222l-221-221q-71 100-71 222m163-313l221 220l221-220q-100-71-221-71t-221 71m534 91L604 510l222 222q70-99 70-221t-71-222"/></svg>';

        // count: número (conectada), null/undefined (falló → "N/D") o
        // beta:true (categoría futura → badge "beta", sin número). vehIds:
        // agent_ids afectados; si hay incidencia y hay ids, la tarjeta es
        // clicable y abre el panel Informes con esos vehículos marcados (el
        // usuario elige el informe). severe: marca las categorías GRAVES
        // (accidentes, mantención vencida): su fondo vira a naranja de alerta
        // cuando count>0. Ralentí y el resto son informativos y no pintan
        // naranja.
        var card = function (bg, title, count, iconSvg, titleAttr, isBeta, iconCls, vehIds, reportType, severe) {
            var body;
            if (isBeta) {
                body = { cls: 'promatic_dashboard_enhancer-stat-card__count promatic_dashboard_enhancer-stat-card__count--beta', html: l('EN DESARROLLO') };
            } else if (count === null || count === undefined) {
                body = { cls: 'promatic_dashboard_enhancer-stat-card__count', html: l('N/D') };
            } else {
                body = { cls: 'promatic_dashboard_enhancer-stat-card__count', html: String(count) };
            }
            var hasIncident = !isBeta && typeof count === 'number' && count > 0;
            var isSevereAlert = hasIncident && severe;
            var clickable = hasIncident && vehIds && vehIds.length;
            var spec = {
                tag: 'a', href: '#',
                style: 'background:' + (isSevereAlert ? 'var(--status-alert-bright)' : bg),
                title: clickable ? (titleAttr + ' — ' + l('clic: abre estos vehículos en el panel Informes')) : titleAttr,
                cls: 'promatic_dashboard_enhancer-stat-card' +
                    (isBeta ? ' promatic_dashboard_enhancer-stat-card--beta' : '') +
                    (hasIncident ? ' promatic_dashboard_enhancer-stat-card--has-alert' : '') +
                    (isSevereAlert ? ' promatic_dashboard_enhancer-stat-card--severe-alert' : '') +
                    (clickable ? ' promatic_dashboard_enhancer-stat-card--clickable' : ''),
                cn: [
                    { tag: 'span', cls: 'promatic_dashboard_enhancer-stat-card__icon' + (iconCls ? ' ' + iconCls : ''), html: iconSvg },
                    { cls: 'promatic_dashboard_enhancer-stat-card__title', html: title },
                    body
                ]
            };
            if (clickable) {
                spec['data-alert-ids'] = vehIds.join(',');
                if (reportType) { spec['data-alert-report'] = String(reportType); }
            }
            return spec;
        };

        // Tarjetas de combustible: el número solo aparece con datos reales;
        // "cargando", "N/D" (sin sensor o sin muestras) y "EN DESARROLLO"
        // (respuesta no reconocida) son estados distintos a un cero. La
        // cobertura va bajo el título. Siempre clicables si hay estado: el
        // modal explica la cobertura aunque el conteo sea 0.
        var me = this;
        var fuelCard = function (kind, bg, title, titleAttr, iconCls) {
            var sm = me._fuelSummary(kind);
            var count = sm.count;
            var beta = sm.state === 'unrecognized';
            if (sm.state === 'loading') { count = '…'; }
            var cov = sm.cov ? '<span class="promatic_dashboard_enhancer-stat-card__cov">' + Ext.String.htmlEncode(sm.cov) + '</span>' : '';
            var spec = card(bg, title + cov, count, svgCombustible,
                titleAttr + (sm.cov ? ' — ' + sm.cov : ''), beta, iconCls,
                sm.ids, null, false);
            if (sm.state !== 'none' && sm.state !== 'loading') {
                spec['data-fuel-alert'] = kind;
                if (spec.cls.indexOf('--clickable') === -1) { spec.cls += ' promatic_dashboard_enhancer-stat-card--clickable'; }
            }
            return spec;
        };

        var idleMin = (((this.config && this.config.ecoScore) || this.DEFAULT_CONFIG.ecoScore).idleThresholdMin) || 120;
        var gridCls = 'promatic_dashboard_enhancer-stat-card-grid';

        this.updateCardBody('alertas_generales', Ext.DomHelper.markup({
            cls: gridCls,
            cn: [
                card('var(--g6)', l('POSIBLE ACCIDENTE'), accidentes, svgAccidente,
                    l('Posible accidente — eventos de los últimos 30 días'), false, 'pde_alert-accidentes',
                    this._alertAccidentesIds || [], null, true),
                card('var(--g7)', l('Requiere mantención'), mantencion, svgMantencion,
                    l('Vehículos con inspección/servicio vencido o pendiente (módulo Técnico-Operacional)'), false, 'pde_alert-mantencion',
                    null, null, true),
                // Ralentí no es clicable por ahora: el informe con el detalle
                // es el "Fleet ECO report" (report_type=223 group=6), que
                // runNativeReport no soporta (necesita group=6). Por eso no
                // se pasa vehIds.
                card('var(--g6)', l('Ralentí excesivo'), ralenti, svgRalenti,
                    l('Vehículos con más de ' + idleMin + ' min de ralentí acumulado en el período'), false, 'pde_alert-ralenti'),
                fuelCard('carga', 'var(--g7)', l('Inconsistencias en Carga'),
                    l('Posibles cargas de combustible: alza de nivel con el vehículo detenido, calculada sobre el sensor'), 'pde_alert-inconsistencias'),
                fuelCard('drenaje', 'var(--g6)', l('Drenaje de Combustible'),
                    l('Posibles drenajes: baja brusca de nivel con el vehículo detenido, calculada sobre el sensor'), 'pde_alert-drenaje'),
                card('var(--g7)', l('GPS Manipulado'), null, svgGpsManual,
                    l('Desconexión intencional del equipo — en desarrollo: aún no hay una fuente de datos confirmada'), true, 'pde_alert-manipulacion'),
                // Conectada solo en cuentas con borderAlert.eventType; es
                // grave: un vehículo detenido en un paso fronterizo sin
                // permiso es un posible vehículo perdido.
                this._alertBorderEnabled
                    ? card('var(--g6)', l('Salida de territorio nacional'), this._alertBorder, svgTerritorio,
                        l('Vehículos detenidos en una geocerca de paso fronterizo (notificación de PILOT)'), false, 'pde_alert-fuerazona',
                        this._alertBorderIds || [], null, true)
                    : card('var(--g6)', l('Salida de territorio nacional'), null, svgTerritorio,
                        l('Vehículo cruza la frontera — pendiente de conexión'), true, 'pde_alert-fuerazona')
            ]
        }));
    },

    /**
     * Safety Score (card 'eco_score'). Fuente: reports.php report_type=223
     * (group=6), el "Fleet ECO report" nativo de PILOT (el del panel
     * Informes). Request/schema en spec/api.md.
     *
     * Respuesta: { data: { "<grupo>": { "<patente>": [c0..c8] } } } c0
     * patente · c1 Excess Idle (s) · c2 Over Speed (s) · c3 Harsh Brake
     * (conteo) · c4 Harsh Accel (conteo) · c5 distancia (km) · c6 Duration
     * (s) · c7 Current Rating (% 0-100, puede ser < 0) · c8 Previous Rating
     * (%).
     *
     * El widget muestra Global (promedio de Current Rating), Flota/Carpeta
     * (promedio de la carpeta elegida en el dropdown del mapa, o de toda la
     * selección) y un ranking de 5 cajas.
     */
    loadEcoScore: function () {
        var me = this;
        var cfg = (me.config && me.config.ecoScore) || (me.DEFAULT_CONFIG.ecoScore || {});
        var days = cfg.windowDays || 8;

        this.withFleetVehicleIds(function (vehIds) {
            var stop = new Date();
            var start = new Date();
            start.setDate(start.getDate() - days);

            // Reusa el cuerpo estándar de reports.php (buildReportBody) y
            // solo sobrescribe group=6 y report_type=223.
            var body = me.buildReportBody(223, vehIds.join(','), start, stop)
                .replace(/(^|&)group=1(&|$)/, '$1group=6$2');

            var ctrl = new AbortController();
            // 45 s y no 25 s: con fleet.maxVehicles=1500 el POST manda hasta
            // 1500 agent_id en un solo request. Con flota chica sobraba
            // margen; con la flota completa daba timeout.
            var to = setTimeout(function () { ctrl.abort(); }, 45000);

            fetch('/backend/ax/reports.php', {
                method: 'POST',
                credentials: 'include',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: body,
                signal: ctrl.signal
            })
                .then(function (resp) {
                    if (!resp.ok) { throw new Error('HTTP ' + resp.status); }
                    return resp.json();
                })
                .then(function (data) {
                    // Cachea la respuesta cruda: loadAlertasGenerales la
                    // reusa para la alerta de ralentí excesivo (c1 = Excess
                    // Idle en segundos) sin una segunda llamada al reporte.
                    me._lastEcoResp = data;
                    me.renderEcoScore(data, days);
                    me.refreshRalentiAlert();
                    me._onLopDataReady();
                })
                .catch(function (err) {
                    var code = me.widgetErrorCode('ECO-SCORE', err);
                    me.updateCardBody('eco_score', l('No se pudo cargar el Safety Score.') + ' (' + code + ')', 0, true);
                })
                .finally(function () { clearTimeout(to); });
        });
    },

    renderEcoScore: function (resp, days) {
        var me = this;
        var groups = (resp && resp.data) || {};
        var rows = [];
        for (var gName in groups) {
            if (!groups.hasOwnProperty(gName)) { continue; }
            var vehs = groups[gName];
            for (var pat in vehs) {
                if (!vehs.hasOwnProperty(pat)) { continue; }
                var c = vehs[pat];
                if (!c || c.length < 9) { continue; }
                rows.push({
                    name: c[0] || pat, group: gName,
                    idle: Number(c[1]) || 0, over: Number(c[2]) || 0,
                    brake: Number(c[3]) || 0, accel: Number(c[4]) || 0,
                    dist: Number(c[5]) || 0, dur: Number(c[6]) || 0,
                    cur: Number(c[7]), prev: Number(c[8])
                });
            }
        }

        this._lastEcoRows = rows;

        if (rows.length === 0) {
            this.updateCardBody('eco_score',
                l('El Fleet ECO report no devolvió datos para el alcance actual.'), 0, true);
            return;
        }

        var avg = function (arr, field) {
            if (arr.length === 0) { return 0; }
            var s = 0;
            for (var i = 0; i < arr.length; i++) { s += arr[i][field]; }
            return Math.round(s / arr.length);
        };

        // report_type=223 puede dar scores < 0; se acotan a 0-100 para la
        // visualización.
        var clamp = function (n) { return Math.max(0, Math.min(100, n)); };

        var globalScore = avg(rows, 'cur');
        var globalPrev = avg(rows, 'prev');

        var onlineTree = this.getOnlineTree();
        var store = onlineTree && onlineTree.getStore && onlineTree.getStore();

        // Agrupar por carpeta del árbol Main: el reporte agrupa por su propio
        // `group` (nombre de grupo de PILOT), que puede no coincidir con las
        // carpetas del árbol. Se cruza por nombre de vehículo: para cada
        // carpeta con hojas seleccionadas, qué filas del reporte le
        // corresponden.
        var folderStats = [];
        var folderOpts = onlineTree ? this.getMapFolderOptions(onlineTree) : [];
        for (var fo = 0; fo < folderOpts.length; fo++) {
            var fNode = store && store.getNodeById ? store.getNodeById(folderOpts[fo].value) : null;
            if (!fNode) { continue; }
            var fNames = {};
            fNode.cascadeBy(function (nd) {
                if (nd !== fNode && nd.get('agentid')) { fNames[String(nd.get('name'))] = true; }
            });
            var fRows = rows.filter(function (x) { return fNames[String(x.name)]; });
            if (fRows.length === 0) { continue; }
            folderStats.push({
                id: folderOpts[fo].value,
                label: folderOpts[fo].label,
                rows: fRows,
                score: avg(fRows, 'cur')
            });
        }

        var scoreMod = function (sc) {
            if (sc >= 75) { return 'good'; }
            if (sc >= 45) { return 'mid'; }
            return 'bad';
        };
        var arrow = function (cur, prev) {
            if (!isFinite(prev)) { return ''; }
            if (cur > prev + 1) { return ' ▲'; }
            if (cur < prev - 1) { return ' ▼'; }
            return ' =';
        };

        var scoreCard = function (label, score, sub) {
            var pct = clamp(score);
            var mod = scoreMod(pct);
            return {
                cls: 'promatic_dashboard_enhancer-eco-score-card promatic_dashboard_enhancer-eco-score-card--' + mod,
                cn: [
                    { cls: 'promatic_dashboard_enhancer-eco-score-card__label', html: label },
                    { cls: 'promatic_dashboard_enhancer-eco-score-card__num-row', cn: [
                        { cls: 'promatic_dashboard_enhancer-eco-score-card__num', html: String(score) },
                        { cls: 'promatic_dashboard_enhancer-eco-score-card__of', html: '/100' }
                    ] },
                    sub ? { cls: 'promatic_dashboard_enhancer-eco-score-card__sub', html: sub } : null
                ].filter(Boolean)
            };
        };

        // Caja del ranking: valor semanal grande arriba + nombre, y debajo el
        // valor de la semana anterior. Color completo por umbral. pos es el
        // índice 0-4 dentro del ranking (2 mejores + mediana + 2 peores). En
        // modo compact (< 28em, CSS) se ocultan pos 1 y 3 (.eco-cell--
        // pos-1/--pos-3) para no desbordar junto a la tarjeta de score de
        // ancho fijo.
        var rankCell = function (item, pos) {
            var mod = scoreMod(item.cur);
            return {
                cls: 'promatic_dashboard_enhancer-eco-cell promatic_dashboard_enhancer-eco-cell--' + mod +
                    ' promatic_dashboard_enhancer-eco-cell--pos-' + pos,
                cn: [
                    { cls: 'promatic_dashboard_enhancer-eco-cell__top', cn: [
                        { cls: 'promatic_dashboard_enhancer-eco-cell__val', html: String(item.cur) },
                        { cls: 'promatic_dashboard_enhancer-eco-cell__name', html: me.displayName(item.name) }
                    ] },
                    { cls: 'promatic_dashboard_enhancer-eco-cell__prev', cn: [
                        { tag: 'span', cls: 'promatic_dashboard_enhancer-eco-cell__prevlbl', html: l('antes') },
                        { tag: 'span', cls: 'promatic_dashboard_enhancer-eco-cell__prevval',
                          html: isFinite(item.prev) ? String(item.prev) : '—' }
                    ] }
                ]
            };
        };

        // Carpeta específica: solo si hay filtro elegido en el dropdown del
        // mapa (el mismo _mapFolderFilter que dispara este reload).
        var specificFolder = null;
        if (this._mapFolderFilter) {
            for (var fs = 0; fs < folderStats.length; fs++) {
                if (String(folderStats[fs].id) === String(this._mapFolderFilter)) {
                    specificFolder = folderStats[fs];
                    break;
                }
            }
        }

        Store.promatic_dashboard_enhancer.Module.debugLog('eco score (report_type=223): ' + rows.length +
            ' vehículos, ' + days + 'd, global=' + globalScore + '% (previo ' + globalPrev +
            '%), ' + folderStats.length + ' carpetas' +
            (specificFolder ? ', específica=' + specificFolder.label : ''));

        // Con una carpeta filtrada, el ranking se calcula sobre ella y no
        // sobre toda la flota; si no, el ranking mostraría vehículos que no
        // son de la carpeta elegida mientras el score grande ya cambió.
        var rankSource = specificFolder ? specificFolder.rows : rows;
        var sorted = rankSource.slice().sort(function (a, b) { return b.cur - a.cur; });

        // Ranking impar de 5: 2 mejores + mediana + 2 peores. Con menos de 5
        // vehículos se muestran los que haya, sin repetir.
        var rankFive = [];
        if (sorted.length <= 5) {
            rankFive = sorted.slice();
        } else {
            var mid = sorted[Math.floor(sorted.length / 2)];
            rankFive = [sorted[0], sorted[1], mid, sorted[sorted.length - 2], sorted[sorted.length - 1]];
        }

        // 1 sola fila: tarjeta de score angosta a la izquierda (Global por
        // defecto; se REEMPLAZA por la carpeta filtrada cuando hay selección,
        // nunca las 2 juntas) + ranking de 5 cajas a la derecha con la
        // mayoría del ancho.
        var activeCard = specificFolder ?
            scoreCard(specificFolder.label, specificFolder.score,
                specificFolder.rows.length + ' ' + l('vehículos')) :
            scoreCard(l('Global Score'), globalScore,
                rows.length + ' ' + l('vehículos') + ' · ' + l('previo') + ' ' + globalPrev + '%');

        var rankCells = [];
        for (var rc = 0; rc < rankFive.length; rc++) { rankCells.push(rankCell(rankFive[rc], rc)); }

        this.updateCardBody('eco_score', Ext.DomHelper.markup({
            cls: 'promatic_dashboard_enhancer-eco-body',
            cn: [
                activeCard,
                { cls: 'promatic_dashboard_enhancer-eco-cells', cn: rankCells }
            ]
        }), 0, true);

    },

    /**
     * Tendencia de Infracciones (card 'violations'). Fuente: reports.php
     * report_type=114 (group=1), reporte nativo de infracciones de manejo.
     * msg trae el texto heredado "Coming soon", pero success:true y data
     * vienen completos.
     *
     * Respuesta: { data: { "<rango de fecha>": [ [veh, group, dateTs, driver,
     * distance, duration, speed, accel, braking, idling, turn, seatbelt,
     * finePer100, totalFine], ... ] } } Cada fila es 1 vehículo en 1 día del
     * rango; se suman las 6 columnas de infracción (índices 6-11) sobre toda
     * la ventana/flota.
     *
     * El widget muestra barras horizontales de conteo total por categoría,
     * sin librería de gráficos (Highcharts, la única disponible en el
     * runtime, se reserva para los exportadores).
     */
    loadViolationsTrend: function () {
        var me = this;
        var cfg = (me.config && me.config.violations) || (me.DEFAULT_CONFIG.violations || {});
        var days = cfg.windowDays || 8;

        this.withFleetVehicleIds(function (vehIds) {
            var stop = new Date();
            var start = new Date();
            start.setDate(start.getDate() - days);

            // 45 s y no 25 s, mismo motivo que Safety Score: con
            // fleet.maxVehicles=1500 el POST tarda más de 25 s.
            me.fetchReportType(114, vehIds.join(','), start, stop, 45000)
                .then(function (data) {
                    me.renderViolationsTrend(data, days);
                })
                .catch(function (err) {
                    var code = me.widgetErrorCode('VIOLATIONS', err);
                    me.updateCardBody('violations', l('No se pudo cargar la tendencia de infracciones.') + ' (' + code + ')', 0, true);
                });
        });
    },

    renderViolationsTrend: function (resp, days) {
        if (!resp || resp.success === false) {
            this.updateCardBody('violations',
                l('El reporte de infracciones no devolvió datos para el alcance actual.'), 0, true);
            return;
        }

        var byDate = (resp && resp.data) || {};
        this._lopCacheViolationRows(byDate);
        this._onLopDataReady();
        var totals = { speed: 0, accel: 0, braking: 0, idling: 0, turn: 0, seatbelt: 0 };
        var rowCount = 0;
        for (var range in byDate) {
            if (!byDate.hasOwnProperty(range)) { continue; }
            var rows = byDate[range] || [];
            for (var i = 0; i < rows.length; i++) {
                var c = rows[i];
                if (!c || c.length < 12) { continue; }
                totals.speed += Number(c[6]) || 0;
                totals.accel += Number(c[7]) || 0;
                totals.braking += Number(c[8]) || 0;
                totals.idling += Number(c[9]) || 0;
                totals.turn += Number(c[10]) || 0;
                totals.seatbelt += Number(c[11]) || 0;
                rowCount++;
            }
        }

        this._lastViolationsTotals = totals;

        if (rowCount === 0) {
            this.updateCardBody('violations',
                l('Sin datos de infracciones para el alcance actual.'), 0, true);
            return;
        }

        var cats = [
            { key: 'speed', label: l('Velocidad') },
            { key: 'accel', label: l('Aceleración') },
            { key: 'braking', label: l('Frenado') },
            { key: 'idling', label: l('Ralentí') },
            { key: 'turn', label: l('Giro') },
            { key: 'seatbelt', label: l('Cinturón') }
        ];
        var maxVal = 0;
        for (var ci = 0; ci < cats.length; ci++) {
            maxVal = Math.max(maxVal, totals[cats[ci].key]);
        }

        // Sin ninguna infracción en la ventana: mismo patrón "todo OK" que
        // Sin Señal GPS, para no mostrar una fila de barras vacías sin
        // sentido visual.
        if (maxVal === 0) {
            this.updateCardBody('violations', Ext.DomHelper.markup({
                cls: 'promatic_dashboard_enhancer-violations-ok',
                html: l('Sin infracciones registradas en los últimos') + ' ' + days + ' ' + l('días')
            }), 0, true);
            return;
        }

        var bar = function (cat) {
            var val = totals[cat.key];
            var pct = maxVal > 0 ? Math.round((val / maxVal) * 100) : 0;
            return {
                cls: 'promatic_dashboard_enhancer-violations-row',
                cn: [
                    { cls: 'promatic_dashboard_enhancer-violations-row__label', html: cat.label },
                    { cls: 'promatic_dashboard_enhancer-violations-row__track', cn: [
                        { cls: 'promatic_dashboard_enhancer-violations-row__fill', style: 'width:' + pct + '%' }
                    ] },
                    { cls: 'promatic_dashboard_enhancer-violations-row__val', html: String(val) }
                ]
            };
        };

        var bars = [];
        for (var b = 0; b < cats.length; b++) { bars.push(bar(cats[b])); }

        this.updateCardBody('violations', Ext.DomHelper.markup({
            cls: 'promatic_dashboard_enhancer-violations-body',
            cn: bars
        }), 0, true);
    },

    /**
     * Hotspots de desconexión (card 'hotspots'): heatmap sobre un
     * MapContainer PROPIO (instancia nueva, NUNCA window.mapContainer, que es
     * la global del mapa Online). Los puntos se agregan por celda de ~0.01° y
     * se pasan a setHeatmap.
     */
    getMapContainerClass: function () {
        return window.MapContainer ||
            (window.Pilot && Pilot.utils && Pilot.utils.MapContainer) || null;
    },

    /**
     * Centroide + bounding box de los vehículos en alcance con coordenadas
     * válidas, para el centrado/zoom inicial de los mapas. Devuelve null si
     * ningún vehículo tiene coordenadas todavía (el llamador usa un
     * fallback).
     */
    _fleetCentroid: function () {
        var onlineTree = this.getOnlineTree();
        if (!onlineTree) { return null; }
        var records = this.getMapScopedRecords(onlineTree);
        var pts = [];
        for (var i = 0; i < records.length; i++) {
            var ll = this._recordLatLon(records[i]);
            if (ll) { pts.push(ll); }
        }
        if (pts.length === 0) { return null; }
        var sumLat = 0, sumLon = 0;
        for (var j = 0; j < pts.length; j++) { sumLat += pts[j][0]; sumLon += pts[j][1]; }
        return { center: [sumLat / pts.length, sumLon / pts.length], points: pts };
    },

    /**
     * Monta un Ext.panel.Panel dentro del div de la card y crea ahí una
     * instancia propia de MapContainer, siguiendo el patrón oficial
     * examples/airports/Map.js:
     * - init(lat, lon, zoom, this.id + '-body', false): el 4º argumento DEBE
     *   ser el id del -body de un panel Ext YA RENDERIZADO, no un <div>
     *   arbitrario (con un div no monta la instancia y MapContainer cae al
     *   mapa global).
     * - checkResize() en el evento 'resize' del panel.
     *
     * Se llama en el afterrender del panel principal, cuando el shell ya está
     * en el DOM con dimensiones.
     */
    buildHotspotsMapPanel: function () {
        var me = this;
        var body = Ext.get('promatic_dashboard_enhancer-card-body-hotspots');
        if (!body) {
            // el shell aún no montó — reintento acotado
            me._hotspotsMountRetry = (me._hotspotsMountRetry || 0) + 1;
            if (me._hotspotsMountRetry < 40) {
                Ext.defer(me.buildHotspotsMapPanel, 300, me);
            }
            return;
        }
        if (me._hotspotsPanel) { return; }
        if (!me.getMapContainerClass()) {
            body.setHtml(l('El mapa no está disponible en este runtime.'));
            return;
        }

        // Limpia el skeleton 'map' y monta el panel Ext ahí.
        body.setHtml('');
        Ext.DomHelper.append(body, {
            cls: 'promatic_dashboard_enhancer-hotspots-map-loading',
            id: 'promatic_dashboard_enhancer-hotspots-map-loading',
            cn: [{ cls: 'promatic_dashboard_enhancer-hotspots-map-loading__spinner' }]
        });
        me._hotspotsPanel = Ext.create('Ext.panel.Panel', {
            renderTo: body,
            cls: 'promatic_dashboard_enhancer-hotspots-map',
            bodyCls: 'promatic_dashboard_enhancer-hotspots-map-body',
            layout: 'fit',
            // Alto fijo, igual al de #card-body-hotspots en CSS: así la
            // columna con Safety Score arriba no necesita scroll. El alto no
            // se ajusta dinámicamente; solo el ancho, vía el ResizeObserver
            // de más abajo (dispara checkResize de Leaflet).
            height: 450,
            border: false,
            listeners: {
                render: function () {
                    try {
                        var MC = me.getMapContainerClass();
                        me._hotspotsMap = new MC('promatic_dashboard_enhancer_hotspots');
                        // Centrado FIJO en la Región Metropolitana
                        // (Santiago), zoom 11: se aprecian mejor los hotspots
                        // sin necesidad de ver el detalle de calles. A
                        // diferencia de fleet_map, este mapa no sigue el
                        // centroide de la flota ni se reencuadra con
                        // fitBounds al recibir el heatmap (setHeatmap corre
                        // con isBounds=false): el foco es "zonas de pérdida
                        // de conexión en la región", no la flota.
                        me._hotspotsMap.init(-33.45, -70.66, 11, this.id + '-body', false);
                        me.populateMapFolderDropdown();
                        me.bindHotspotsGapModeToggle();
                        // Su reporte de cortes es de los más pesados: durante
                        // el arranque lo dispara la cadena de startInitialLoad.
                        if (me._startupDone) {
                            me.loadFleetHeatmap();
                        } else {
                            me._hotspotsNeedsLoad = true;
                        }
                        // Leaflet midió el contenedor antes de que terminara
                        // el layout flex: se recalcula a los 300/700 ms para
                        // que ocupe todo el ancho.
                        Ext.defer(function () {
                            if (me._hotspotsMap && me._hotspotsMap.checkResize) { me._hotspotsMap.checkResize(); }
                        }, 300);
                        Ext.defer(function () {
                            if (me._hotspotsMap && me._hotspotsMap.checkResize) { me._hotspotsMap.checkResize(); }
                        }, 700);
                        // El ResizeObserver NO toca la altura del panel Ext
                        // (setHeight): solo dispara checkResize() para que
                        // Leaflet se re-mida cuando cambia el ancho de la
                        // columna (breakpoints). Un alto ajustable a mano
                        // (resize:both) competía con el layout responsive y
                        // dejaba el mapa "flotando" con el alto del último
                        // drag.
                        if (window.ResizeObserver && body.dom) {
                            me._hotspotsResizeObserver = new ResizeObserver(function () {
                                if (me._hotspotsMap && me._hotspotsMap.checkResize) { me._hotspotsMap.checkResize(); }
                            });
                            me._hotspotsResizeObserver.observe(body.dom);
                        }
                    } catch (err) {
                        me.widgetErrorCode('HOTSPOTS-INIT', err);
                        this.body.setHtml(l('No se pudo inicializar el mapa de pérdida de conexión.'));
                    }
                },
                resize: function () {
                    if (me._hotspotsMap && me._hotspotsMap.checkResize) {
                        me._hotspotsMap.checkResize();
                    }
                }
            }
        });
    },

    /**
     * Extrae [lat, lon] de un record del online_tree probando los campos que
     * PILOT suele usar. Si un build expone otro nombre, agregarlo acá: el
     * console.warn (0 con coords) es la señal de que falta un campo.
     */
    _recordLatLon: function (rec) {
        var g = function (k) {
            var v = rec.get ? rec.get(k) : (rec.data ? rec.data[k] : undefined);
            return (v === undefined || v === null || v === '') ? undefined : Number(v);
        };
        var pairs = [['lat', 'lon'], ['lat', 'lng'], ['latitude', 'longitude'], ['y', 'x']];
        for (var i = 0; i < pairs.length; i++) {
            var la = g(pairs[i][0]);
            var lo = g(pairs[i][1]);
            if (isFinite(la) && isFinite(lo) && la !== 0 && lo !== 0) {
                return [la, lo];
            }
        }
        // Algunos builds anidan la posición en last_event / last_pos.
        var nested = (rec.get && rec.get('last_event')) || (rec.data && rec.data.last_event) || {};
        var nla = Number(nested.lat), nlo = Number(nested.lon || nested.lng);
        if (isFinite(nla) && isFinite(nlo) && nla !== 0 && nlo !== 0) {
            return [nla, nlo];
        }
        return null;
    },

    /**
     * Lista de { value, label } de las carpetas del árbol "Principal" con al
     * menos una hoja SELECCIONADA en el panel Main (value = id del nodo
     * carpeta). Si el alcance es "toda la flota", cae a "carpetas con ≥1 hoja
     * con agentid".
     *
     * Solo cuentan vehículos HIJOS DIRECTOS de la carpeta: una carpeta
     * contenedora sin vehículos propios (toda su flota en una subcarpeta)
     * aparecería duplicada junto a la subcarpeta real sin aportar nada.
     */
    getMapFolderOptions: function (onlineTree) {
        var store = onlineTree && onlineTree.getStore && onlineTree.getStore();
        var root = store && store.getRoot && store.getRoot();
        if (!root) { return []; }

        var scopeAll = this.effectiveFleetScope() !== 'pilot-selection';
        // Set de agent_ids seleccionados en Main (si aplica).
        var selected = null;
        if (!scopeAll) {
            selected = {};
            var ids = this.getPilotSelectionIds(onlineTree) || [];
            for (var i = 0; i < ids.length; i++) { selected[String(ids[i])] = true; }
        }

        var out = [];
        root.cascadeBy(function (node) {
            if (node === root) { return; }
            if (node.get('agentid')) { return; }
            var hasDirectLeaf = false;
            if (node.eachChild) {
                node.eachChild(function (c) {
                    if (hasDirectLeaf) { return; }
                    var aid = c.get('agentid');
                    if (!aid) { return; }
                    if (scopeAll || selected[String(aid)]) { hasDirectLeaf = true; }
                });
            }
            if (hasDirectLeaf) {
                out.push({ value: node.getId(), label: node.get('text') || node.get('name') || l('(carpeta)') });
            }
        });
        return out;
    },

    populateMapFolderDropdown: function () {
        var me = this;
        var sel = document.getElementById('promatic_dashboard_enhancer-map-folder');
        if (!sel) { return; }
        var onlineTree = this.getOnlineTree();
        if (!onlineTree) { return; }

        var opts = this.getMapFolderOptions(onlineTree);
        // Reconstruye: "Ver todos" + una <option> por carpeta.
        sel.innerHTML = '';
        var all = document.createElement('option');
        all.value = '__all__';
        all.textContent = l('Ver todos los seleccionados');
        sel.appendChild(all);
        for (var i = 0; i < opts.length; i++) {
            var o = document.createElement('option');
            o.value = String(opts[i].value);
            o.textContent = opts[i].label;
            sel.appendChild(o);
        }

        if (!sel._pdeBound) {
            sel._pdeBound = true;
            sel.addEventListener('change', function () {
                me._mapFolderFilter = (sel.value === '__all__') ? null : sel.value;
                me.loadFleetHeatmap();
                // La caja "Flota/Carpeta" del Safety Score sigue el mismo filtro.
                me.showCardSkeleton('eco_score', 'donut');
                me.loadEcoScore();
            });
        }
    },

    /**
     * Toggle "Cortes largos" / "Intermitencias breves". A diferencia del
     * dropdown de carpeta no dispara un fetch: ambas capas ya están
     * calculadas en _hotspotsPointsByMode (loadFleetHeatmap) y solo se
     * redibuja con _paintHotspotsHeatmap.
     */
    bindHotspotsGapModeToggle: function () {
        var me = this;
        var sel = document.getElementById('promatic_dashboard_enhancer-hotspots-gap-mode');
        if (!sel || sel._pdeBound) { return; }
        sel._pdeBound = true;
        me._hotspotsGapMode = sel.value || 'long';
        sel.addEventListener('change', function () {
            me._hotspotsGapMode = sel.value;
            me._paintHotspotsHeatmap();
        });
    },

    /**
     * Records de vehículos para el mapa: si hay filtro de carpeta activo,
     * solo las hojas descendientes de ese nodo; si no, el alcance normal
     * (selección de "Principal" o toda la flota).
     */
    getMapScopedRecords: function (onlineTree) {
        return this._folderScopedRecords(onlineTree, this._mapFolderFilter);
    },

    /**
     * Versión genérica de getMapScopedRecords: también la usa fleet_map con
     * su propio filtro (_fleetMapFolderFilter), sin compartir estado con el
     * dropdown de hotspots.
     */
    _folderScopedRecords: function (onlineTree, folderId) {
        if (!folderId) {
            return this.getScopedFleetRecords(onlineTree);
        }
        var store = onlineTree.getStore();
        var folder = store.getNodeById ? store.getNodeById(folderId) : null;
        if (!folder) { return this.getScopedFleetRecords(onlineTree); }
        var recs = [];
        folder.cascadeBy(function (c) {
            if (c !== folder && c.get('agentid')) { recs.push(c); }
        });
        return recs;
    },

    /**
     * Muestra/oculta el overlay de carga: el mapa base se ve vacío mientras
     * loadFleetHeatmap trae la data. El div se crea una sola vez en
     * buildHotspotsMapPanel; acá solo se alterna su visibilidad (antes de
     * cada fetch y al recibir data o error).
     */
    _showHotspotsMapLoading: function (show) {
        var el = Ext.get('promatic_dashboard_enhancer-hotspots-map-loading');
        if (!el) { return; }
        el.setDisplayed(!!show);
    },

    /**
     * Heatmap histórico de cortes de conexión sobre _hotspotsMap, vía
     * reports.php report_type=73 ("Connection lost"). events.php type=15 no
     * se usa: daba total:0 en la cuenta de pruebas.
     *
     * 2 CAPAS: los cortes breves (10-90 s) son los candidatos a túneles y
     * pasos subterráneos, pero quedaban bajo el piso minGapSeconds usado para
     * todo el request, y solo aparecían sucursales/estacionamientos. Ahora se
     * pide con el piso más bajo (shortGapMinSeconds) para traer todo en 1
     * sola llamada y se separa client-side por duración real: "Cortes largos"
     * (> minGapSeconds: vehículo apagado o fuera de cobertura) vs.
     * "Intermitencias breves" (shortGapMinSeconds–shortGapMaxSeconds). Nunca
     * se mezclan en el mismo heatmap: las sucursales dominarían visualmente
     * sobre los túneles. El toggle (_hotspotsGapMode, default 'long') decide
     * cuál se pinta.
     *
     * Esta card es independiente de fleet_map: nunca se fusionan ni comparten
     * estado. Tampoco lista vehículos offline (eso vive en el modal de Sin
     * Señal GPS): se enfoca en dónde se pierde conexión con más frecuencia,
     * no en quién está desconectado ahora.
     */
    loadFleetHeatmap: function () {
        var me = this;
        var map = this._hotspotsMap;
        if (!map) { return; }

        var onlineTree = this.getOnlineTree();
        if (!onlineTree) { return; }

        me._showHotspotsMapLoading(true);

        var cfg = (this.config && this.config.hotspots) || this.DEFAULT_CONFIG.hotspots;
        var windowDays = (cfg && cfg.windowDays) || 30;
        var minGapSeconds = (cfg && cfg.minGapSeconds) || 120;
        var shortMin = (cfg && cfg.shortGapMinSeconds) || 10;
        var shortMax = (cfg && cfg.shortGapMaxSeconds) || 90;

        this.withFleetVehicleIds(function (vehIds) {
            var csv = vehIds.join(',');
            var stop = new Date();
            var start = new Date();
            start.setDate(start.getDate() - windowDays);

            me.fetchConnectionLostPoints(csv, start, stop, shortMin)
                .then(function (rawPoints) {
                    var bucketsLong = {}, bucketsShort = {};
                    var countLong = 0, countShort = 0;
                    for (var i = 0; i < rawPoints.length; i++) {
                        var p = rawPoints[i];
                        var duration = p[2] || 0;
                        var isShort = duration >= shortMin && duration <= shortMax;
                        var isLong = duration >= minGapSeconds;
                        // Zona muerta entre las dos bandas: no es
                        // clasificable en ninguna capa.
                        if (!isShort && !isLong) { continue; }
                        var key = p[0].toFixed(3) + ',' + p[1].toFixed(3);
                        var target = isShort ? bucketsShort : bucketsLong;
                        if (!target[key]) { target[key] = { lat: p[0], lng: p[1], count: 0 }; }
                        target[key].count++;
                        if (isShort) { countShort++; } else { countLong++; }
                    }
                    var toPoints = function (buckets) {
                        var pts = [];
                        for (var k in buckets) { if (buckets.hasOwnProperty(k)) { pts.push(buckets[k]); } }
                        return pts;
                    };
                    me._hotspotsPointsByMode = {
                        long: toPoints(bucketsLong),
                        short: toPoints(bucketsShort)
                    };

                    Store.promatic_dashboard_enhancer.Module.debugLog('hotspots desconexión: ' + rawPoints.length +
                        ' cortes totales (report_type=73, ' + windowDays + 'd) — ' +
                        countLong + ' largos (>' + minGapSeconds + 's, ' + me._hotspotsPointsByMode.long.length + ' celdas), ' +
                        countShort + ' breves (' + shortMin + '-' + shortMax + 's, ' + me._hotspotsPointsByMode.short.length + ' celdas)' +
                        (me._mapFolderFilter ? ' (carpeta ' + me._mapFolderFilter + ')' : ''));

                    Store.promatic_dashboard_enhancer.Module.debugLog('hotspots desconexión: histograma de duraciones (s)',
                        me._durationHistogram(rawPoints));
                    me._paintHotspotsHeatmap();
                })
                .catch(function (err) {
                    me._showHotspotsMapLoading(false);
                    me.widgetErrorCode('FLEETMAP-HEATMAP-FETCH', err);
                });
        });
    },

    /**
     * Cuenta los cortes por tramo de duración (segundos) y da mínimo/máximo.
     * Solo para diagnóstico: si no hay ningún corte bajo el piso de la capa
     * "breve", el vacío viene del reporte (no registra cortes cortos) y no de
     * la clasificación o el dibujo.
     */
    _durationHistogram: function (rawPoints) {
        var edges = [10, 30, 60, 90, 120, 300, 900, 3600];
        var hist = { '<10': 0 };
        var i, min = Infinity, max = 0;
        for (i = 0; i < edges.length; i++) {
            hist[edges[i] + '+'] = 0;
        }
        for (i = 0; i < rawPoints.length; i++) {
            var d = rawPoints[i][2] || 0;
            if (d < min) { min = d; }
            if (d > max) { max = d; }
            var key = '<10';
            for (var e = 0; e < edges.length; e++) {
                if (d >= edges[e]) { key = edges[e] + '+'; }
            }
            hist[key]++;
        }
        hist.min = rawPoints.length ? min : null;
        hist.max = rawPoints.length ? max : null;
        return hist;
    },

    /**
     * Pinta la capa activa (_hotspotsGapMode, 'long'|'short') sobre
     * _hotspotsMap. Está separado de loadFleetHeatmap para que el toggle
     * pueda redibujar sin volver a pedir datos a la API.
     */
    _paintHotspotsHeatmap: function () {
        var me = this;
        var map = this._hotspotsMap;
        if (!map || !this._hotspotsPointsByMode) { return; }

        var mode = this._hotspotsGapMode || 'long';
        var points = this._hotspotsPointsByMode[mode] || [];
        var label = mode === 'short' ? l('Intermitencias breves') : l('Pérdidas de conexión');

        // Se quita SOLO la capa propia (id guardado al crearla). removeAllHeatsMap
        // barre todas las capas de calor de la instancia y, al dejar el mapa sin
        // capas, el mapa se reencuadraba a Sudamérica al cambiar a una capa vacía.
        try {
            if (this._hotspotsHeat && typeof map.removeHeatMap === 'function') {
                var prevId = (this._hotspotsHeat.id !== undefined) ? this._hotspotsHeat.id : this._hotspotsHeat;
                map.removeHeatMap(prevId);
            }
        } catch (e) { /* no-op */ }
        this._hotspotsHeat = null;

        if (points.length === 0) {
            console.warn('[promatic_dashboard_enhancer] hotspots desconexión: 0 celdas para el modo "' + mode + '".');
            me._showHotspotsMapLoading(false);
            return;
        }

        try {
            if (typeof map.setHeatmap === 'function') {
                // isBounds=false: el mapa mantiene el centro/zoom fijo de la
                // Región Metropolitana y no se reencuadra según la dispersión
                // de los puntos.
                this._hotspotsHeat = map.setHeatmap(points, false, label);
            }
            if (map.checkResize) { map.checkResize(); }
        } catch (err) {
            me.widgetErrorCode('FLEETMAP-HEATMAP', err);
        } finally {
            me._showHotspotsMapLoading(false);
        }
    },

    /**
     * Trae los [lat, lon] de cada evento type=`type` en el rango. Mismo
     * endpoint que fetchEventVehicles, pero devuelve coordenadas en vez de
     * agent_ids; descarta items sin lat/lon válidos.
     */
    fetchEventPoints: function (vehIdsCsv, type, dateStart, dateStop) {
        var qs = 'cmd=search&veh=' + encodeURIComponent(vehIdsCsv) +
            '&type=' + encodeURIComponent(type) +
            '&date_start=' + encodeURIComponent(dateStart) +
            '&date_stop=' + encodeURIComponent(dateStop) +
            '&limit=1000&page=1&start=0';
        return fetch('/backend/ax/mod/events.php?' + qs, { credentials: 'include' })
            .then(function (resp) {
                if (!resp.ok) { throw new Error('HTTP ' + resp.status); }
                return resp.json();
            })
            .then(function (data) {
                var items = (data && data.items) || [];
                var out = [];
                for (var i = 0; i < items.length; i++) {
                    var lat = Number(items[i].lat), lon = Number(items[i].lon);
                    if (isFinite(lat) && isFinite(lon) && lat !== 0 && lon !== 0) {
                        out.push([lat, lon]);
                    }
                }
                return out;
            });
    },

    /**
     * Trae los cortes de señal del rango: reports.php report_type=73, group=1
     * (ver spec/api.md). Devuelve [lat, lon, durationSeconds] por corte.
     *
     * Respuesta: data: { "<rango legible>": { "<índice disperso>": { lat,
     * lon, msg, veh, data: [patente, modelo, ts_start, ts_stop,
     * duration_seconds, {lat, lon}] } } }
     *
     * OJO: cada rango es un OBJETO con claves numéricas dispersas
     * ("0","8","41"...), NO un array. Hay que iterar con for...in y nunca
     * asumir .length ni índices consecutivos; con .length el heatmap daba "0
     * celdas" siempre pese a haber datos.
     *
     * contrTimeFloor viaja en el parámetro contr_time del body (el "Min time
     * (sec)" del reporte nativo): es el PISO que aplica la API de PILOT, y un
     * corte más corto ni siquiera viaja en la respuesta. Por eso
     * loadFleetHeatmap siempre pide con el piso más bajo configurado y separa
     * breves/largos client-side, evitando 2 requests.
     */
    fetchConnectionLostPoints: function (vehIdsCsv, startDate, stopDate, contrTimeFloor) {
        var body = this.buildReportBody(73, vehIdsCsv, startDate, stopDate)
            .replace(/contr_time=\d+/, 'contr_time=' + encodeURIComponent(contrTimeFloor))
            .replace(/group=\d+/, 'group=1');
        return fetch('/backend/ax/reports.php', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: body
        })
            .then(function (resp) {
                if (!resp.ok) { throw new Error('HTTP ' + resp.status); }
                return resp.json();
            })
            .then(function (json) {
                var data = (json && json.data) || {};
                var out = [];
                for (var rangeKey in data) {
                    if (!data.hasOwnProperty(rangeKey)) { continue; }
                    var items = data[rangeKey] || {};
                    for (var itemKey in items) {
                        if (!items.hasOwnProperty(itemKey)) { continue; }
                        var item = items[itemKey];
                        var lat = Number(item.lat), lon = Number(item.lon);
                        if (isFinite(lat) && isFinite(lon) && lat !== 0 && lon !== 0) {
                            var duration = (item.data && Number(item.data[4])) || 0;
                            out.push([lat, lon, duration]);
                        }
                    }
                }
                return out;
            });
    },

    /**
     * Ubicación Global de la Flota (card 'fleet_map'): CADA vehículo en su
     * última posición conocida, agrupado con el clustering NATIVO de
     * MapContainer (addCluster, que usa window.L.markerClusterGroup; mismo
     * mecanismo que el mapa "Main" de PILOT, con instancia propia). Usa
     * marcadores reales y no heatmap: un heatmap de última posición
     * desaparece al hacer zoom y no deja ver el ícono del vehículo.
     *
     * addCluster(markersArray, options) no está documentada en
     * MapContainer.md; la firma real es:
     * - markersArray: [{ lat, lon, id, size, tooltip, ... }], mismo shape que
     *   addMarker (internamente llama addMarker por cada uno con
     *   notBindToMap:true).
     * - options: { id, isClusterHoverContent, ...opciones de
     *   Leaflet.markercluster }. isClusterHoverContent:true arma un popup que
     *   depende de Ext.getCmp('online_objects_tree'), específico del mapa
     *   nativo y no reutilizable acá; se usa tooltip individual por marcador.
     *
     * Ícono del marcador: mismo endpoint nativo que el mapa "Main"
     * (/backend/markers/get.php?a=1, con &i=1 = ignición encendida). `firing`
     * del online_tree coincide 1:1 con el ícono de llave (naranja =
     * encendido, gris = apagado) según verificación visual contra decenas de
     * vehículos. URL relativa a window.location.origin, nunca host fijo: la
     * extensión corre en cualquier subdominio de PILOT.
     */
    buildFleetMapPanel: function () {
        var me = this;
        var body = Ext.get('promatic_dashboard_enhancer-card-body-fleet_map');
        if (!body) {
            me._fleetMapMountRetry = (me._fleetMapMountRetry || 0) + 1;
            if (me._fleetMapMountRetry < 40) {
                Ext.defer(me.buildFleetMapPanel, 300, me);
            }
            return;
        }
        if (me._fleetMapPanel) { return; }
        if (!me.getMapContainerClass()) {
            body.setHtml(l('El mapa no está disponible en este runtime.'));
            return;
        }

        body.setHtml('');
        me._fleetMapPanel = Ext.create('Ext.panel.Panel', {
            renderTo: body,
            cls: 'promatic_dashboard_enhancer-hotspots-map',
            bodyCls: 'promatic_dashboard_enhancer-hotspots-map-body',
            layout: 'fit',
            height: 450,
            border: false,
            listeners: {
                render: function () {
                    try {
                        var MC = me.getMapContainerClass();
                        me._fleetMap = new MC('promatic_dashboard_enhancer_fleet_map');
                        var centroid = me._fleetCentroid();
                        var initLat = centroid ? centroid.center[0] : -33.45;
                        var initLon = centroid ? centroid.center[1] : -70.66;
                        var initZoom = centroid ? 11 : 5;
                        me._fleetMap.init(initLat, initLon, initZoom, this.id + '-body', false);
                        me.populateFleetMapFolderDropdown();
                        me.loadFleetMapClusters();
                        Ext.defer(function () {
                            if (me._fleetMap && me._fleetMap.checkResize) { me._fleetMap.checkResize(); }
                        }, 300);
                        Ext.defer(function () {
                            if (me._fleetMap && me._fleetMap.checkResize) { me._fleetMap.checkResize(); }
                        }, 700);
                        if (window.ResizeObserver && body.dom) {
                            me._fleetMapResizeObserver = new ResizeObserver(function () {
                                if (me._fleetMap && me._fleetMap.checkResize) { me._fleetMap.checkResize(); }
                            });
                            me._fleetMapResizeObserver.observe(body.dom);
                        }
                    } catch (err) {
                        me.widgetErrorCode('FLEETMAP-INIT', err);
                        this.body.setHtml(l('No se pudo inicializar el mapa de la flota.'));
                    }
                },
                resize: function () {
                    if (me._fleetMap && me._fleetMap.checkResize) {
                        me._fleetMap.checkResize();
                    }
                }
            }
        });
    },

    populateFleetMapFolderDropdown: function () {
        var me = this;
        var sel = document.getElementById('promatic_dashboard_enhancer-fleetmap-folder');
        if (!sel) { return; }
        var onlineTree = this.getOnlineTree();
        if (!onlineTree) { return; }

        var opts = this.getMapFolderOptions(onlineTree);
        sel.innerHTML = '';
        var all = document.createElement('option');
        all.value = '__all__';
        all.textContent = l('Ver todos los seleccionados');
        sel.appendChild(all);
        for (var i = 0; i < opts.length; i++) {
            var o = document.createElement('option');
            o.value = String(opts[i].value);
            o.textContent = opts[i].label;
            sel.appendChild(o);
        }

        if (!sel._pdeBound) {
            sel._pdeBound = true;
            sel.addEventListener('change', function () {
                me._fleetMapFolderFilter = (sel.value === '__all__') ? null : sel.value;
                me.loadFleetMapClusters();
            });
        }
    },

    /**
     * Arma 1 marcador por vehículo en alcance (posición actual del
     * online_tree, sin request HTTP) y los agrupa con addCluster(). Hay un
     * único cluster fijo (id 'fleet_map_cluster') que se limpia y reconstruye
     * completo en cada carga: es más simple y suficientemente barato para el
     * tamaño de flota esperado (updateMarkers() existe si hiciera falta
     * actualizar in-place).
     */
    loadFleetMapClusters: function () {
        var me = this;
        var map = this._fleetMap;
        if (!map) { return; }

        var onlineTree = this.getOnlineTree();
        if (!onlineTree) { return; }

        // Las geocercas de sucursal/base se cargan una vez (cache en
        // _lastGeofences por loadBranchGeofences) y se reusan en cada
        // refresh. Solo importan si hay algún mapeo configurado
        // (config.branches.clientMap); si no, se salta el fetch entero.
        var cfg = (me.config && me.config.branches) || (me.DEFAULT_CONFIG.branches || {});
        var hasClientMap = (cfg.clientMap || []).length > 0;

        var withGeofences = function () {
            me._renderFleetMapMarkers(onlineTree);
        };

        if (hasClientMap && !me._lastGeofences) {
            me.loadBranchGeofences(function () { withGeofences(); });
        } else {
            withGeofences();
        }
    },

    /**
     * Construye y dibuja los marcadores. Está separado de
     * loadFleetMapClusters para poder esperar la carga (async) de geocercas
     * sin anidar todo el cuerpo en el callback del fetch.
     */
    _renderFleetMapMarkers: function (onlineTree) {
        var me = this;
        var map = this._fleetMap;
        if (!map) { return; }

        var records = this._folderScopedRecords(onlineTree, this._fleetMapFolderFilter);
        var markers = [];
        var withCoords = 0;
        var branchMatches = 0;
        // Solo se dibujan los polígonos de las geocercas (Bases/Sucursales)
        // que coinciden con al menos 1 vehículo del scope actual: el grupo
        // completo (~80 geocercas) saturaría el mapa. Keyed por id de
        // geocerca, { geofence, count }; el count arma el label del polígono
        // (ej. "BASE 40 - 46 (2 vehículos)").
        var matchedBranches = {};

        for (var i = 0; i < records.length; i++) {
            var ll = this._recordLatLon(records[i]);
            if (!ll) { continue; }
            withCoords++;
            var online = records[i].get ? !!records[i].get('is_server_online') : false;
            // ?a=1 = auto sin llave (apagado); ?a=1&i=1 = auto con llave
            // naranja (ignición encendida). Ver buildFleetMapPanel.
            var firing = records[i].get ? !!records[i].get('firing') : false;
            var iconUrl = window.location.origin + '/backend/markers/get.php?a=1' + (firing ? '&i=1' : '');

            // Match sucursal/base SOLO para vehículos apagados (firing=0):
            // uno encendido está en tránsito, no "estacionado en una
            // ubicación". Requiere _lastGeofences ya cargado
            // (loadFleetMapClusters lo garantiza si hay clientMap). Lleva
            // try/catch propio: es un dato OPCIONAL del tooltip y un error
            // acá (geocerca malformada, etc.) nunca debe tumbar el render del
            // mapa completo; sin catch, un error dejaba el mapa vacío.
            var branch = null;
            if (!firing && this._lastGeofences) {
                try {
                    branch = this._findVehicleBranch(records[i], this._lastGeofences);
                    if (branch) {
                        branchMatches++;
                        if (!matchedBranches[branch.id]) {
                            matchedBranches[branch.id] = { geofence: branch, count: 0 };
                        }
                        matchedBranches[branch.id].count++;
                    }
                } catch (branchErr) {
                    me.widgetErrorCode('FLEETMAP-BRANCH-MATCH', branchErr);
                }
            }

            var tooltipMsg = me.displayName(records[i].get ? records[i].get('name') : '') +
                (online ? ' — ' + l('En línea') : ' — ' + l('Sin conexión')) +
                (firing ? ' — ' + l('Encendido') : ' — ' + l('Apagado'));
            if (branch) {
                tooltipMsg += ' — ' + l('En') + ' ' + branch.name;
            }

            markers.push({
                id: 'promatic_dashboard_enhancer_fleet_map_veh_' + (records[i].get ? records[i].get('agentid') : i),
                lat: ll[0],
                lon: ll[1],
                icon: iconUrl,
                // 'mini' se veía diminuto a cualquier zoom comparado con el
                // ícono del mapa nativo; 'medium' es el tamaño de referencia
                // de MapContainer.md para íconos de vehículo con detalle.
                size: 'medium',
                tooltip: { msg: tooltipMsg }
            });
        }

        Store.promatic_dashboard_enhancer.Module.debugLog('ubicación global de la flota: ' + records.length +
            ' vehículos en alcance' + (this._fleetMapFolderFilter ? ' (carpeta ' + this._fleetMapFolderFilter + ')' : '') +
            ', ' + withCoords + ' con coords' +
            (this._lastGeofences ? ', ' + branchMatches + ' con match de sucursal/base' : ''));

        try {
            if (map.getCluster && map.getCluster('fleet_map_cluster') && map.removeCluster) {
                map.removeCluster('fleet_map_cluster');
            }
        } catch (e) { /* no-op */ }

        try {
            var prevIds = me._fleetMapBranchPolygonIds || [];
            for (var pi = 0; pi < prevIds.length; pi++) {
                if (map.removePolygon) { map.removePolygon(prevIds[pi]); }
            }
        } catch (e2) { /* no-op */ }
        me._fleetMapBranchPolygonIds = [];

        if (markers.length === 0) {
            console.warn('[promatic_dashboard_enhancer] ubicación global de la flota: 0 vehículos con coordenadas.');
            return;
        }

        try {
            if (typeof map.addCluster === 'function') {
                map.addCluster(markers, { id: 'fleet_map_cluster' });
            }
            // Polígonos de las geocercas con al menos 1 match de vehículo
            // apagado (ver matchedBranches). Los ids se guardan en
            // _fleetMapBranchPolygonIds para limpiarlos antes de cada pasada.
            if (typeof map.setPolygon === 'function') {
                for (var bId in matchedBranches) {
                    if (!matchedBranches.hasOwnProperty(bId)) { continue; }
                    var entryB = matchedBranches[bId];
                    var polyPoints = me._geofencePolygonPoints(entryB.geofence);
                    if (!polyPoints || polyPoints.length < 3) { continue; }
                    var polyId = 'promatic_dashboard_enhancer_fleet_map_branch_' + bId;
                    var polyLabel = entryB.geofence.name + ' (' + entryB.count + ' ' +
                        (entryB.count === 1 ? l('vehículo') : l('vehículos')) + ')';
                    try {
                        map.setPolygon(polyPoints, {
                            id: polyId,
                            label: polyLabel,
                            tooltip: { msg: polyLabel },
                            color: '#008be3',
                            fillOpacity: 0.15
                        });
                        me._fleetMapBranchPolygonIds.push(polyId);
                    } catch (polyErr) {
                        me.widgetErrorCode('FLEETMAP-BRANCH-POLYGON', polyErr);
                    }
                }
            }
            // Se reencuadra con fitBounds contra los puntos de los marcadores
            // realmente dibujados (`markers`). Usar _fleetCentroid() acá
            // sería incorrecto: lee getMapScopedRecords() (scope general), un
            // set DISTINTO al dibujado (_folderScopedRecords con
            // _fleetMapFolderFilter), y con la flota completa daba un bounds
            // enorme: zoom-out extremo y 1 solo cluster con el 100% de los
            // vehículos.
            if (map.setMapCenter) {
                var pts = [];
                for (var m = 0; m < markers.length; m++) { pts.push([markers[m].lat, markers[m].lon]); }
                if (pts.length > 0) {
                    map.setMapCenter(pts);
                    // +1 de zoom sobre el resultado de fitBounds. Es relativo
                    // al zoom que Leaflet calculó según la dispersión real de
                    // los puntos: un valor fijo se vería mal tanto con flota
                    // muy concentrada como muy dispersa.
                    if (map.setMapZoom && map.getMap) {
                        var leafletMap = map.getMap();
                        if (leafletMap && leafletMap.getZoom) {
                            map.setMapZoom(leafletMap.getZoom() + 1);
                        }
                    }
                }
            }
            if (map.checkResize) { map.checkResize(); }
        } catch (err) {
            this.widgetErrorCode('FLEETMAP-CLUSTER', err);
        }
    },

    /**
     * Geocercas de la cuenta: GET /api/v3/geofences (URL relativa, same-
     * origin). Trae TODAS; qué cuenta como "sucursal" lo decide
     * _matchGeofenceGroup (patrón de nombre) o config.branches.clientMap, no
     * un campo del schema.
     */
    loadBranchGeofences: function (callback) {
        var me = this;
        var ctrl = new AbortController();
        var to = setTimeout(function () { ctrl.abort(); }, 20000);

        fetch('/api/v3/geofences', {
            method: 'GET',
            credentials: 'include',
            signal: ctrl.signal
        })
            .then(function (resp) {
                if (!resp.ok) { throw new Error('HTTP ' + resp.status); }
                return resp.json();
            })
            .then(function (data) {
                me._lastGeofences = Array.isArray(data) ? data : (data && data.data) || [];
                callback(null, me._lastGeofences);
            })
            .catch(function (err) {
                var code = me.widgetErrorCode('BRANCHES-GEOFENCES', err);
                callback(code, []);
            })
            .finally(function () { clearTimeout(to); });
    },

    /**
     * true si `name` (group_name de una geocerca) coincide con algún patrón
     * de config.branches.namePatterns (substring simple, sin distinguir
     * mayúsculas).
     */
    _matchGeofenceGroup: function (name) {
        if (!name) { return false; }
        var cfg = (this.config && this.config.branches) || (this.DEFAULT_CONFIG.branches || {});
        var patterns = cfg.namePatterns || [];
        var lower = String(name).toLowerCase();
        for (var i = 0; i < patterns.length; i++) {
            if (lower.indexOf(String(patterns[i]).toLowerCase()) !== -1) { return true; }
        }
        return false;
    },

    /**
     * Test punto-en-polígono estándar (ray casting / even-odd). points: array
     * de [lat, lon] (mismo formato que devuelve
     * MapContainer.getPointsZoneData). O(n) sobre los vértices, sin
     * dependencias.
     */
    _pointInPolygon: function (lat, lon, points) {
        var inside = false;
        for (var i = 0, j = points.length - 1; i < points.length; j = i++) {
            var yi = points[i][0], xi = points[i][1];
            var yj = points[j][0], xj = points[j][1];
            var intersect = ((yi > lat) !== (yj > lat)) &&
                (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi);
            if (intersect) { inside = !inside; }
        }
        return inside;
    },

    /**
     * Filtra `records` (del online_tree) a los que caen dentro del polígono
     * `points` según su última posición (_recordLatLon). Devuelve [{ record,
     * lat, lon }] y no solo records, para no recalcular la posición en el
     * llamador.
     */
    _vehiclesInGeofence: function (points, records) {
        var out = [];
        for (var i = 0; i < records.length; i++) {
            var ll = this._recordLatLon(records[i]);
            if (!ll) { continue; }
            if (this._pointInPolygon(ll[0], ll[1], points)) {
                out.push({ record: records[i], lat: ll[0], lon: ll[1] });
            }
        }
        return out;
    },

    /**
     * Sube por la cadena de ancestros de `record` en el árbol y devuelve la
     * entrada de config.branches.clientMap cuyo folderMatch aparece (sin
     * distinguir mayúsculas, substring) en el nombre de algún ancestro, o
     * null. No asume profundidad fija: cubre la carpeta padre directa o
     * varios niveles arriba.
     */
    _clientMapEntryForRecord: function (record) {
        var cfg = (this.config && this.config.branches) || (this.DEFAULT_CONFIG.branches || {});
        var clientMap = cfg.clientMap || [];
        if (clientMap.length === 0) { return null; }

        var node = record && record.parentNode;
        while (node) {
            var name = String(node.get ? (node.get('text') || node.get('name') || '') : '').toLowerCase();
            if (name) {
                for (var i = 0; i < clientMap.length; i++) {
                    var entry = clientMap[i];
                    var nombres = [].concat(entry.nombreFlota || []);
                    for (var j = 0; j < nombres.length; j++) {
                        if (nombres[j] && name.indexOf(String(nombres[j]).toLowerCase()) !== -1) {
                            return entry;
                        }
                    }
                }
            }
            node = node.parentNode;
        }
        return null;
    },

    /**
     * Dado un record de vehículo APAGADO y las geocercas ya cargadas,
     * devuelve la geocerca de sucursal/base COMPLETA (no solo el nombre:
     * _renderFleetMapMarkers necesita `id`/`points` para dibujar el polígono)
     * que contiene su posición actual, o null si no hay match de cliente o no
     * cae en ninguna. Solo compara contra los group_names EXACTOS listados
     * para ese cliente: una geocerca de otro grupo, aunque comparta texto, no
     * cuenta.
     */
    _findVehicleBranch: function (record, geofences) {
        var entry = this._clientMapEntryForRecord(record);
        if (!entry || !entry.groupNames || entry.groupNames.length === 0) { return null; }

        var ll = this._recordLatLon(record);
        if (!ll) { return null; }

        for (var i = 0; i < geofences.length; i++) {
            var g = geofences[i];
            if (!g.group_name || entry.groupNames.indexOf(g.group_name) === -1) { continue; }
            // Polígono (ray casting) o círculo (distancia al centro):
            // las bases definidas como círculo nunca daban match.
            if (this._pointInGeofence(ll[0], ll[1], g)) {
                return g;
            }
        }
        return null;
    },

    /**
     * Normaliza `geofence.points` al formato [[lat, lon], ...] que espera
     * _pointInPolygon. GET /api/v3/geofences devuelve `points` ya como array
     * de pares, NO como el string "lat,lon|lat,lon|..." que parsea
     * MapContainer.getPointsZoneData (formato de otro endpoint): usar ese
     * parser acá rompe con "e.split is not a function".
     */
    _geofencePolygonPoints: function (geofence) {
        var raw = geofence && geofence.points;
        if (!Array.isArray(raw)) { return null; }
        var out = [];
        for (var i = 0; i < raw.length; i++) {
            var p = raw[i];
            if (Array.isArray(p) && p.length >= 2 && isFinite(p[0]) && isFinite(p[1])) {
                out.push([Number(p[0]), Number(p[1])]);
            }
        }
        return out;
    },

    /**
     * Escribe un mensaje de estado (placeholder, error) en el mount de la
     * lista de 'vehicles_by_branch'. NUNCA usar updateCardBody para esto:
     * hace setHtml() sobre TODO el body de la card y destruye #branch-map-
     * mount con el panel Ext/MapContainer ya montado. Antes de que exista el
     * mount no hace nada.
     */
    _updateBranchStatus: function (html) {
        var mount = Ext.get('promatic_dashboard_enhancer-branch-veh-list-mount');
        if (mount) {
            mount.setHtml(Ext.DomHelper.markup({ cls: 'promatic_dashboard_enhancer-branch-veh-empty', html: html }));
        }
    },

    /**
     * Widget 'vehicles_by_branch' (retirado del shell, código conservado).
     * Instancia propia de MapContainer con el mismo patrón que
     * buildHotspotsMapPanel: nunca window.mapContainer y requiere el -body de
     * un panel Ext ya renderizado. Estructura: [div del mapa] + [div de la
     * lista, hermano]; el panel Ext se renderiza SOLO en el primero para que
     * su layout 'fit' no se coma el espacio de la lista.
     */
    buildBranchMapPanel: function () {
        var me = this;
        var body = Ext.get('promatic_dashboard_enhancer-card-body-vehicles_by_branch');
        if (!body) {
            me._branchMountRetry = (me._branchMountRetry || 0) + 1;
            if (me._branchMountRetry < 40) {
                Ext.defer(me.buildBranchMapPanel, 300, me);
            }
            return;
        }
        if (me._branchPanel) { return; }
        if (!me.getMapContainerClass()) {
            body.setHtml(l('El mapa no está disponible en este runtime.'));
            return;
        }

        body.setHtml(Ext.DomHelper.markup({
            cn: [
                { tag: 'div', id: 'promatic_dashboard_enhancer-branch-map-mount' },
                { tag: 'div', id: 'promatic_dashboard_enhancer-branch-veh-list-mount', cls: 'promatic_dashboard_enhancer-branch-veh-list-mount' }
            ]
        }));

        me._branchPanel = Ext.create('Ext.panel.Panel', {
            renderTo: 'promatic_dashboard_enhancer-branch-map-mount',
            cls: 'promatic_dashboard_enhancer-hotspots-map',
            bodyCls: 'promatic_dashboard_enhancer-hotspots-map-body',
            layout: 'fit',
            height: 300,
            border: false,
            listeners: {
                render: function () {
                    try {
                        var MC = me.getMapContainerClass();
                        me._branchMap = new MC('promatic_dashboard_enhancer_branch');
                        me._branchMap.init(-33.45, -70.66, 5, this.id + '-body', false);
                        me.populateBranchFleetDropdown();
                        me.populateBranchSelectDropdown();
                        Ext.defer(function () {
                            if (me._branchMap && me._branchMap.checkResize) { me._branchMap.checkResize(); }
                        }, 300);
                        Ext.defer(function () {
                            if (me._branchMap && me._branchMap.checkResize) { me._branchMap.checkResize(); }
                        }, 700);
                        if (window.ResizeObserver) {
                            var mapMount = Ext.get('promatic_dashboard_enhancer-branch-map-mount');
                            if (mapMount && mapMount.dom) {
                                me._branchResizeObserver = new ResizeObserver(function () {
                                    if (me._branchMap && me._branchMap.checkResize) { me._branchMap.checkResize(); }
                                });
                                me._branchResizeObserver.observe(mapMount.dom);
                            }
                        }
                    } catch (err) {
                        me.widgetErrorCode('BRANCHES-MAP-INIT', err);
                        this.body.setHtml(l('No se pudo inicializar el mapa de sucursales.'));
                    }
                },
                resize: function () {
                    if (me._branchMap && me._branchMap.checkResize) {
                        me._branchMap.checkResize();
                    }
                }
            }
        });
    },

    /**
     * Dropdown 1: carpetas de flota del árbol "Principal" (mismo listado que
     * usa el mapa de hotspots). El texto entre corchetes del group_name de la
     * geocerca (ver _extractBracketTag) identifica al cliente dueño de la
     * flota: si aparece en el nombre de la carpeta elegida, el dropdown 2 se
     * acota al grupo de geocercas correspondiente.
     */
    populateBranchFleetDropdown: function () {
        var me = this;
        var sel = document.getElementById('promatic_dashboard_enhancer-branch-group');
        if (!sel) { return; }

        var onlineTree = this.getOnlineTree();
        var opts = onlineTree ? this.getMapFolderOptions(onlineTree) : [];

        sel.innerHTML = '';
        if (opts.length === 0) {
            var empty = document.createElement('option');
            empty.value = '';
            empty.textContent = l('Sin carpetas de flota disponibles');
            sel.appendChild(empty);
            return;
        }

        var placeholder = document.createElement('option');
        placeholder.value = '';
        placeholder.textContent = l('— Elige una flota —');
        sel.appendChild(placeholder);
        for (var j = 0; j < opts.length; j++) {
            var o = document.createElement('option');
            o.value = String(opts[j].value);
            o.textContent = opts[j].label;
            sel.appendChild(o);
        }

        if (!sel._pdeBound) {
            sel._pdeBound = true;
            sel.addEventListener('change', function () {
                me._branchFolderFilter = sel.value || null;
                var selectedOpt = sel.options[sel.selectedIndex];
                me._branchFolderLabel = (me._branchFolderFilter && selectedOpt) ? selectedOpt.textContent : null;
                me._branchGeofenceFilter = null;
                me.populateBranchSelectDropdown();
            });
        }
    },

    /**
     * Extrae el texto entre el primer par de corchetes de un string. El
     * group_name de una geocerca de sucursal/base trae ahí al
     * cliente/organización (ej. "Bases [X]" → "X"). null si no hay corchetes.
     */
    _extractBracketTag: function (str) {
        var m = /\[([^\]]+)\]/.exec(String(str || ''));
        return m ? m[1] : null;
    },

    /**
     * Dropdown 2: geocercas cuyo group_name coincide con _matchGeofenceGroup
     * Y, si hay una flota elegida en el dropdown 1, cuyo tag entre corchetes
     * aparece en el nombre de esa carpeta. Sin flota elegida muestra todas
     * las que cumplen el patrón. Dispara el fetch de geocercas si todavía no
     * se cargó.
     */
    populateBranchSelectDropdown: function () {
        var me = this;
        var sel = document.getElementById('promatic_dashboard_enhancer-branch-select');
        if (!sel) { return; }

        this.loadBranchGeofences(function (errCode, geofences) {
            if (errCode) {
                sel.innerHTML = '';
                var errOpt = document.createElement('option');
                errOpt.value = '';
                errOpt.textContent = l('Error al cargar geocercas') + ' (' + errCode + ')';
                sel.appendChild(errOpt);
                me._updateBranchStatus(l('No se pudieron cargar las geocercas.') + ' (' + errCode + ')');
                return;
            }

            var folderLabelLower = me._branchFolderLabel ? String(me._branchFolderLabel).toLowerCase() : null;

            var matches = geofences.filter(function (g) {
                if (!g.group_name || !me._matchGeofenceGroup(g.group_name)) { return false; }
                if (!folderLabelLower) { return true; }
                var tag = me._extractBracketTag(g.group_name);
                return tag ? folderLabelLower.indexOf(tag.toLowerCase()) !== -1 : false;
            });

            sel.innerHTML = '';
            if (matches.length === 0) {
                var emptyOpt = document.createElement('option');
                emptyOpt.value = '';
                emptyOpt.textContent = folderLabelLower
                    ? l('Sin sucursales/bases para esta flota')
                    : l('Sin geocercas de sucursal configuradas');
                sel.appendChild(emptyOpt);
                me._updateBranchStatus(folderLabelLower
                    ? l('No se encontraron geocercas cuyo grupo coincida con el nombre de esta flota.')
                    : l('No se encontraron geocercas cuyo grupo coincida con "sucursal"/"base". Ajustar config.branches.namePatterns si Pilot usa otro nombre.'));
                return;
            }

            var placeholder = document.createElement('option');
            placeholder.value = '';
            placeholder.textContent = l('— Elige una sucursal —');
            sel.appendChild(placeholder);
            for (var i = 0; i < matches.length; i++) {
                var o = document.createElement('option');
                o.value = String(matches[i].id);
                o.textContent = (matches[i].name || ('#' + matches[i].id)) +
                    (matches[i].group_name ? ' [' + matches[i].group_name + ']' : '');
                sel.appendChild(o);
            }

            if (!sel._pdeBound) {
                sel._pdeBound = true;
                sel.addEventListener('change', function () {
                    me._branchGeofenceFilter = sel.value || null;
                    me.renderBranchVehicles();
                });
            }

            me._updateBranchStatus(l('Elige una flota y luego una sucursal.'));
        });
    },

    /**
     * Con una sucursal elegida (_branchGeofenceFilter = id de geocerca):
     * parsea sus points, corre _vehiclesInGeofence contra la flota en
     * alcance, dibuja el polígono + 1 marcador por match y lista nombre +
     * online/offline bajo el mapa (mismo is_server_online que Estado de
     * Flota).
     */
    renderBranchVehicles: function () {
        var me = this;
        var map = this._branchMap;

        try {
            if (me._branchPolygonId && map && map.removePolygon) { map.removePolygon(me._branchPolygonId); }
        } catch (e) { /* no-op */ }
        try {
            if (map && map.removeAllMarkers) { map.removeAllMarkers('promatic_dashboard_enhancer_branch'); }
        } catch (e) { /* no-op */ }
        me._branchPolygonId = null;

        if (!this._branchFolderFilter) {
            this._updateBranchStatus(l('Elige una flota y luego una sucursal.'));
            return;
        }
        if (!this._branchGeofenceFilter || !this._lastGeofences) {
            this._updateBranchStatus(l('Elige también una sucursal.'));
            return;
        }

        var geofence = null;
        for (var i = 0; i < this._lastGeofences.length; i++) {
            if (String(this._lastGeofences[i].id) === String(this._branchGeofenceFilter)) {
                geofence = this._lastGeofences[i];
                break;
            }
        }
        if (!geofence) {
            this._updateBranchStatus(l('Geocerca no encontrada.'));
            return;
        }

        var points = (map && map.getPointsZoneData) ? map.getPointsZoneData(geofence.points) : null;
        if (!points || points.length < 3) {
            this._updateBranchStatus(l('La geocerca no tiene un polígono válido.'));
            return;
        }

        // Flota restringida a la carpeta elegida en el dropdown 1, con su
        // propio filtro (_branchFolderFilter), independiente del mapa de
        // hotspots.
        var onlineTree = this.getOnlineTree();
        var records = [];
        if (onlineTree) {
            var store = onlineTree.getStore();
            var folder = store && store.getNodeById ? store.getNodeById(this._branchFolderFilter) : null;
            if (folder) {
                folder.cascadeBy(function (c) {
                    if (c !== folder && c.get('agentid')) { records.push(c); }
                });
            }
        }
        var matches = this._vehiclesInGeofence(points, records);

        try {
            if (map && map.setPolygon) {
                me._branchPolygonId = 'promatic_dashboard_enhancer_branch_polygon';
                map.setPolygon(points, {
                    id: me._branchPolygonId,
                    label: geofence.name,
                    color: '#008be3',
                    fillOpacity: 0.15
                });
            }
            if (map && map.addMarker) {
                for (var m = 0; m < matches.length; m++) {
                    var rec = matches[m].record;
                    map.addMarker({
                        id: 'promatic_dashboard_enhancer_branch_veh_' + m,
                        lat: matches[m].lat,
                        lon: matches[m].lon,
                        size: 'mini',
                        customOptions: { type: 'promatic_dashboard_enhancer_branch' },
                        tooltip: { msg: me.displayName(rec.get ? rec.get('name') : '') }
                    });
                }
            }
            if (map && map.setMapCenter && points.length > 0) {
                map.setMapCenter(points);
            }
            if (map && map.checkResize) { map.checkResize(); }
        } catch (err) {
            this.widgetErrorCode('BRANCHES-RENDER', err);
        }

        var rows = [];
        for (var r = 0; r < matches.length; r++) {
            var rr = matches[r].record;
            var online = rr.get ? !!rr.get('is_server_online') : false;
            rows.push({
                cls: 'promatic_dashboard_enhancer-branch-veh-row',
                cn: [
                    { cls: 'promatic_dashboard_enhancer-branch-veh-row__name', html: me.displayName(rr.get ? rr.get('name') : '') },
                    { cls: 'promatic_dashboard_enhancer-branch-veh-row__status promatic_dashboard_enhancer-branch-veh-row__status--' + (online ? 'online' : 'offline'),
                      html: online ? l('En línea') : l('Sin conexión') }
                ]
            });
        }

        var listHtml = rows.length > 0
            ? Ext.DomHelper.markup({ cls: 'promatic_dashboard_enhancer-branch-veh-list', cn: rows })
            : Ext.DomHelper.markup({ cls: 'promatic_dashboard_enhancer-branch-veh-empty', html: l('Ningún vehículo dentro de esta sucursal ahora mismo.') });

        Store.promatic_dashboard_enhancer.Module.debugLog('vehículos por sucursal: "' + geofence.name +
            '" — ' + matches.length + ' de ' + records.length + ' vehículos en alcance');

        var mount = Ext.get('promatic_dashboard_enhancer-branch-veh-list-mount');
        if (mount) { mount.setHtml(listHtml); }
    },

    // =====================================================================
    // Widgets de la vista LOP (administrador de flota)
    //
    // Bloque autocontenido: cada widget es un par load/render independiente
    // que escribe en su propia card con updateCardBody(id, html, 0, true)
    // (optional=true: si la card no está montada en el shell activo, no pasa
    // nada). El shell que los muestre usa lopWidgetCards() para las cards y
    // llama loadLopWidgets() al montar y al refrescar.
    //
    // Escala: la flota principal ronda los 1350 vehículos y PILOT ya cerró
    // sesiones por ráfagas. Por eso (1) todo lo que se pueda se agrega en el
    // cliente sobre datos ya cargados, (2) los reportes pesados van en lotes
    // chicos, en serie y con pausa, solo sobre vehículos con actividad
    // reciente, (3) los resultados se cachean y (4) un widget pesado no
    // arranca hasta que termina el anterior.
    //
    // Distinción que atraviesa todo el bloque: "sin dato" (N/D) no es "cero".
    // La configuración de sensores es por vehículo, así que cada widget
    // muestra cobertura (cuántos vehículos tienen el dato).
    // =====================================================================

    LOP_CARD_IDS: {
        sucursales: 'lop_sucursales',
        estacionados: 'lop_estacionados',
        conduccion: 'lop_conduccion',
        combustible: 'lop_combustible',
        mantencion: 'lop_mantencion',
        tag: 'lop_tag',
        rutas: 'lop_rutas'
    },

    // Todos los valores se pueden pisar con config.lop.<sección> (config.json
    // o config remota). Los umbrales de negocio (km de servicio, % de
    // sobreconsumo) son un punto de partida razonable, no una norma del
    // cliente: se ajustan por cuenta.
    LOP_DEFAULTS: {
        // batchSize/batchPauseMs: lotes de veh_id por POST a reports.php. La
        // pausa evita la ráfaga; batchTimeoutMs coincide con el timeout de
        // flota completa de los demás reportes. maxVehicles acota el total
        // por widget (se prioriza a los vehículos con movimiento más
        // reciente). cacheMinutes: vigencia del resultado de un reporte
        // pesado; el botón Actualizar lo ignora. startDelayMs deja pasar la
        // carga inicial del resto de los widgets antes de pedir reportes.
        batch: { batchSize: 60, batchPauseMs: 1500, batchTimeoutMs: 45000, maxVehicles: 600, cacheMinutes: 30, startDelayMs: 5000 },
        // minKm: bajo ese recorrido el L/100 km es ruido y el vehículo no
        // entra al ranking. overconsumptionPct: un vehículo está en
        // sobreconsumo si supera en ese % la mediana de su cohorte (su
        // carpeta si tiene al menos minCohort vehículos con dato; si no, la
        // flota). distCol/fuelCol: índice de columna a usar si la detección
        // por nombre de encabezado no acierta con el reporte de la cuenta.
        fuel: { windowDays: 30, minKm: 100, overconsumptionPct: 20, minCohort: 5, rankCount: 8, explode: 3, distCol: null, fuelCol: null },
        // minKm: bajo ese recorrido el índice por 100 km no se calcula.
        driving: { rankCount: 8, minKm: 50 },
        // intervalKm: cada cuántos km se sugiere servicio; warnWithinKm:
        // cuánto antes del próximo múltiplo se avisa; highOdometerKm:
        // odómetro desde el cual se sugiere revisión general.
        maintenance: { intervalKm: 10000, warnWithinKm: 1000, highOdometerKm: 100000, rankCount: 8 },
        tag: { windowDays: 30, rankCount: 8, explode: 3 },
        branches: { rankCount: 12 }
    },

    _lopCfg: function (section) {
        var user = (this.config && this.config.lop && this.config.lop[section]) || {};
        return Ext.apply(Ext.apply({}, this.LOP_DEFAULTS[section] || {}), user);
    },

    /**
     * Cards de los widgets LOP como specs de cardMarkup, indexadas por clave
     * lógica (ver LOP_CARD_IDS). El shell LOP decide en qué orden y dónde se
     * ubican.
     */
    lopWidgetCards: function () {
        var ids = this.LOP_CARD_IDS;
        var out = {};
        out.sucursales = this.cardMarkup(ids.sucursales, {
            title: l('Vehículos disponibles por Sucursal'),
            hint: l('Vehículos del alcance cuya última posición cae dentro de una sucursal o base del cliente (geocercas configuradas). Disponible = estacionado y en línea. Solo cuentan los vehículos de flotas con sucursales configuradas.'),
            noFooter: true, skeleton: 'ranking'
        });
        out.estacionados = this.cardMarkup(ids.estacionados, {
            title: l('% de Vehículos Estacionados por Sucursal'),
            hint: l('De los vehículos presentes en cada sucursal, qué porcentaje está estacionado (no en movimiento y con señal). Un porcentaje bajo indica vehículos que están saliendo o con problemas de conexión.'),
            noFooter: true, skeleton: 'ranking'
        });
        out.conduccion = this.cardMarkup(ids.conduccion, {
            title: l('Conducción'),
            hint: l('Frenadas, aceleraciones y curvas bruscas y excesos de velocidad por vehículo o conductor, normalizados por 100 km. Reutiliza el Safety Score (Fleet ECO report) y las infracciones de manejo ya cargadas, sin consultas nuevas. Un 0 puede significar que el vehículo no tiene sensor de conducción brusca: revisa la cobertura.'),
            noFooter: true, skeleton: 'ranking'
        });
        out.combustible = this.cardMarkup(ids.combustible, {
            title: l('Rendimiento de Combustible'),
            hint: l('Consumo por norma (reporte de combustible de PILOT, no requiere sensor de tanque) y L/100 km por vehículo. Sobreconsumo = más de un porcentaje configurable sobre la mediana de su carpeta. Solo vehículos con recorrido mínimo y norma de consumo configurada.'),
            noFooter: true, skeleton: 'ranking'
        });
        out.mantencion = this.cardMarkup(ids.mantencion, {
            title: l('Kilometraje para Mantención'),
            hint: l('Odómetro de cada vehículo (current_mileage de PILOT) frente al intervalo de servicio y al umbral de revisión configurados. Vehículos sin odómetro cargado figuran como N/D, no como 0 km.'),
            noFooter: true, skeleton: 'ranking'
        });
        out.tag = this.cardMarkup(ids.tag, {
            title: l('Vehículos que más consumen TAG'),
            hint: l('Pasadas por pórticos de peaje por vehículo en el período (reporte Toll Roads de PILOT, módulo pagado aparte).'),
            noFooter: true, skeleton: 'ranking'
        });
        out.rutas = this.cardMarkup(ids.rutas, {
            title: l('Vehículos fuera de Rutas preestablecidas'),
            hint: l('Requiere una fuente que asigne rutas a vehículos. Hoy no hay una confirmada en PILOT.'),
            noFooter: true, bodyHtml: this._lopDevMarkup(l('Rutas preestablecidas: pendiente de definir la fuente de datos.'))
        });
        return out;
    },

    /**
     * Arranca los widgets LOP. Lo primero que corre es todo lo que se
     * calcula en el cliente; los reportes pesados (combustible, peajes) se
     * encadenan: uno a la vez, después de startDelayMs. force=true (botón
     * Actualizar) ignora la caché de reportes.
     */
    loadLopWidgets: function (force) {
        var me = this;
        this._lopEnsureExportOptions();
        this._lopBindClicks();

        this.loadLopBranches();
        this.renderLopMaintenance();
        this.renderLopDriving();
        this.updateCardBody(this.LOP_CARD_IDS.rutas, this._lopDevMarkup(l('Rutas preestablecidas: pendiente de definir la fuente de datos.')), 0, true);

        if (this._lopHeavyBusy) { return; }
        this._lopHeavyBusy = true;
        var done = function () { me._lopHeavyBusy = false; };
        var delay = this._lopCfg('batch').startDelayMs;
        Ext.defer(function () {
            me.loadLopFuel(force)
                .then(function () { return me.loadLopTag(force); })
                .then(done, done);
        }, delay);
    },

    /**
     * Hook para loadEcoScore / renderViolationsTrend: cuando llega uno de los
     * reportes de conducción se repinta el widget con lo que haya (los dos
     * llegan en momentos distintos y el segundo puede fallar por timeout).
     */
    _onLopDataReady: function () {
        if (!this._lopStarted) { return; }
        try {
            this.renderLopDriving();
        } catch (err) {
            this.widgetErrorCode('LOP-CONDUCCION', err);
        }
    },

    // ---------------------------------------------------------------------
    // Utilidades puras (sin DOM ni red; se prueban en Node)
    // ---------------------------------------------------------------------

    _lopMedian: function (values) {
        return this._lopPercentile(values, 50);
    },

    /** Percentil por interpolación lineal; [] → null. No modifica `values`. */
    _lopPercentile: function (values, p) {
        if (!values || values.length === 0) { return null; }
        var s = values.slice().sort(function (a, b) { return a - b; });
        var pos = (s.length - 1) * p / 100;
        var lo = Math.floor(pos), hi = Math.ceil(pos);
        return s[lo] + (s[hi] - s[lo]) * (pos - lo);
    },

    /**
     * Número desde una celda de reporte: acepta número, "45.2 km", "1.234,5"
     * o HTML con texto. Devuelve null (no 0) si no hay número: sin dato no es
     * cero. integerAmount: ver la nota sobre separadores de miles.
     */
    _lopNum: function (v, integerAmount) {
        if (typeof v === 'number') { return isFinite(v) ? v : null; }
        if (typeof v !== 'string') { return null; }
        var t = v.replace(/<[^>]*>/g, '').replace(/\s/g, '');
        var m = t.match(/-?\d+(?:[.,]\d+)*/);
        if (!m) { return null; }
        var s = m[0];
        // "1.200" es ambiguo (1,2 o 1200). Los montos en pesos son enteros,
        // así que con integerAmount un único separador seguido de 3 dígitos
        // es de miles; km y litros siguen leyéndose como decimales.
        if (integerAmount && /^-?\d{1,3}([.,]\d{3})+$/.test(s)) { return parseFloat(s.replace(/[.,]/g, '')); }
        var lastDot = s.lastIndexOf('.'), lastComma = s.lastIndexOf(',');
        if (lastDot !== -1 && lastComma !== -1) {
            // El último separador es el decimal; el otro agrupa miles.
            var dec = Math.max(lastDot, lastComma);
            s = s.slice(0, dec).replace(/[.,]/g, '') + '.' + s.slice(dec + 1);
        } else if (lastComma !== -1) {
            s = s.replace(',', '.');
        }
        var n = parseFloat(s);
        return isFinite(n) ? n : null;
    },

    _lopStripTags: function (v) {
        return String(v == null ? '' : v).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
    },

    /** Campo de un record del árbol Online (get() o data), null si falta o está vacío. */
    _recordField: function (rec, key) {
        var v = rec && rec.get ? rec.get(key) : undefined;
        if ((v === undefined || v === null) && rec && rec.data) { v = rec.data[key]; }
        return (v === undefined || v === null || v === '') ? null : v;
    },

    _lopFmt: function (n, dec) {
        if (n === null || n === undefined || !isFinite(n)) { return l('N/D'); }
        var d = dec || 0;
        var s = Number(n).toFixed(d);
        var parts = s.split('.');
        parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, '.');
        return parts.join(',');
    },

    _lopFmtDur: function (sec) {
        if (sec === null || sec === undefined || !isFinite(sec)) { return l('N/D'); }
        var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
        return h + ':' + (m < 10 ? '0' : '') + m + ' h';
    },

    _lopDistanceM: function (lat1, lon1, lat2, lon2) {
        var R = 6371000, rad = Math.PI / 180;
        var dLat = (lat2 - lat1) * rad, dLon = (lon2 - lon1) * rad;
        var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
        return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
    },

    /**
     * Junta las "filas" de la respuesta de un reporte sin asumir su forma:
     * los reportes de PILOT anidan data por rango de fechas, grupo o
     * vehículo, y una fila es un array que empieza con un valor simple (el
     * nombre del objeto) o un objeto con .data de ese tipo. Devuelve
     * [{ veh, cells }]. Profundidad acotada para no recorrer basura.
     */
    _lopCollectRows: function (node, out, depth) {
        out = out || [];
        depth = depth || 0;
        if (depth > 6 || node === null || typeof node !== 'object') { return out; }
        var isPrim = function (v) { return v === null || typeof v !== 'object'; };
        var i, k;
        if (Array.isArray(node)) {
            if (node.length >= 2 && isPrim(node[0])) {
                out.push({ veh: String(node[0]), cells: node });
                return out;
            }
            for (i = 0; i < node.length; i++) { this._lopCollectRows(node[i], out, depth + 1); }
            return out;
        }
        if (Array.isArray(node.data) && node.data.length >= 2 && isPrim(node.data[0])) {
            out.push({ veh: node.veh != null ? String(node.veh) : String(node.data[0]), cells: node.data });
            return out;
        }
        for (k in node) {
            if (node.hasOwnProperty(k)) { this._lopCollectRows(node[k], out, depth + 1); }
        }
        return out;
    },

    /**
     * Nombres de columna desde resp.headers (filas de { name, colspan? }):
     * se elige la última fila de encabezado cuya longitud, con colspan
     * expandido, calza con el ancho de la fila de datos. null si ninguna.
     */
    _lopColumnNames: function (resp, rowLen) {
        var hdr = resp && resp.headers;
        if (!Array.isArray(hdr)) { return null; }
        for (var r = hdr.length - 1; r >= 0; r--) {
            var row = hdr[r];
            if (!Array.isArray(row)) { continue; }
            var names = [];
            for (var c = 0; c < row.length; c++) {
                var cell = row[c];
                var nm = (cell && typeof cell === 'object') ? (cell.name || cell.text || cell.header || '') : String(cell);
                var span = (cell && typeof cell === 'object') ? (Number(cell.colspan || cell.cols) || 1) : 1;
                for (var s = 0; s < span; s++) { names.push(this._lopStripTags(nm)); }
            }
            if (names.length === rowLen) { return names; }
        }
        return null;
    },

    /** Primer índice de `names` que cumple `include` y no `exclude`; -1 si no hay. */
    _lopFindCol: function (names, include, exclude) {
        if (!names) { return -1; }
        for (var i = 1; i < names.length; i++) {
            if (include.test(names[i]) && !(exclude && exclude.test(names[i]))) { return i; }
        }
        return -1;
    },

    /**
     * Ranking de conducción. rows: [{ name, dist, brake, accel, turn, speed }]
     * con null donde no hay dato. metric: 'total' | 'brake' | 'accel' |
     * 'turn' | 'speed'. Índice = eventos por 100 km; los vehículos bajo
     * minKm no entran al ranking (su índice sería ruido) y se cuentan en
     * `excluded`. Una métrica sin dato (null) tampoco puntúa.
     */
    _lopRankDriving: function (rows, metric, minKm) {
        var ranked = [], excluded = 0, noData = 0;
        for (var i = 0; i < rows.length; i++) {
            var r = rows[i];
            var val;
            if (metric === 'total') {
                var parts = [r.brake, r.accel, r.turn];
                var any = false, sum = 0;
                for (var p = 0; p < parts.length; p++) {
                    if (parts[p] !== null && parts[p] !== undefined) { any = true; sum += parts[p]; }
                }
                val = any ? sum : null;
            } else {
                val = r[metric];
            }
            if (val === null || val === undefined) { noData++; continue; }
            if (!(r.dist >= minKm)) { excluded++; continue; }
            ranked.push({ row: r, value: val, index: val / r.dist * 100 });
        }
        ranked.sort(function (a, b) { return b.index - a.index || b.value - a.value; });
        return { ranked: ranked, excluded: excluded, noData: noData };
    },

    /**
     * Sobreconsumo de combustible. rows: [{ name, km, liters, group }].
     * Elegible: km >= minKm y liters > 0 (liters 0 con km > 0 significa que
     * la norma de consumo no está configurada en ese vehículo: es N/D, no un
     * vehículo que no gasta). L/100 km = liters / km * 100. Cada vehículo se
     * compara contra la MEDIANA de su cohorte (carpeta con al menos
     * minCohort elegibles; si no, toda la flota): un camión y un sedán no
     * son comparables, y la mediana no la arrastran los valores extremos.
     */
    _lopFuelAnalysis: function (rows, opts) {
        var eligible = [], noNorm = 0, lowKm = 0;
        var i;
        for (i = 0; i < rows.length; i++) {
            var r = rows[i];
            if (!(r.km >= opts.minKm)) { lowKm++; continue; }
            if (!(r.liters > 0)) { noNorm++; continue; }
            eligible.push({ name: r.name, group: r.group || '', km: r.km, liters: r.liters, lPer100: r.liters / r.km * 100 });
        }
        var all = eligible.map(function (e) { return e.lPer100; });
        var fleetMedian = this._lopMedian(all);
        var byGroup = {};
        for (i = 0; i < eligible.length; i++) {
            var g = eligible[i].group;
            (byGroup[g] = byGroup[g] || []).push(eligible[i].lPer100);
        }
        var factor = 1 + (opts.overconsumptionPct || 0) / 100;
        var flagged = 0;
        for (i = 0; i < eligible.length; i++) {
            var e = eligible[i];
            var cohort = byGroup[e.group];
            var useGroup = e.group !== '' && cohort && cohort.length >= opts.minCohort;
            e.refMedian = useGroup ? this._lopMedian(cohort) : fleetMedian;
            e.refLabel = useGroup ? 'carpeta' : 'flota';
            e.ratio = e.refMedian > 0 ? e.lPer100 / e.refMedian : null;
            e.over = e.ratio !== null && e.ratio >= factor;
            if (e.over) { flagged++; }
        }
        return {
            eligible: eligible, flagged: flagged, noNorm: noNorm, lowKm: lowKm,
            fleetMedian: fleetMedian,
            p90: this._lopPercentile(all, 90),
            totalLiters: eligible.reduce(function (a, e) { return a + e.liters; }, 0)
        };
    },

    /**
     * Mantención por kilometraje. rows: [{ name, odo }] con odo null si el
     * vehículo no informa odómetro (0 también cuenta como sin dato: un
     * odómetro en 0 es un equipo sin lectura, no un vehículo nuevo). Estado:
     * 'high' (odómetro >= highOdometerKm), 'due' (a menos de warnWithinKm
     * del próximo múltiplo de intervalKm) u 'ok'.
     */
    _lopMaintenanceAnalysis: function (rows, opts) {
        var withData = [], noData = 0, i;
        for (i = 0; i < rows.length; i++) {
            var r = rows[i];
            if (!(r.odo > 0)) { noData++; continue; }
            var since = r.odo % opts.intervalKm;
            var toNext = opts.intervalKm - since;
            var status = 'ok';
            if (r.odo >= opts.highOdometerKm) { status = 'high'; }
            else if (toNext <= opts.warnWithinKm) { status = 'due'; }
            withData.push({ name: r.name, odo: r.odo, toNext: toNext, status: status });
        }
        var weight = { high: 2, due: 1, ok: 0 };
        withData.sort(function (a, b) { return weight[b.status] - weight[a.status] || b.odo - a.odo; });
        var high = 0, due = 0;
        for (i = 0; i < withData.length; i++) {
            if (withData[i].status === 'high') { high++; } else if (withData[i].status === 'due') { due++; }
        }
        return { rows: withData, noData: noData, high: high, due: due };
    },

    // ---------------------------------------------------------------------
    // Geocercas: forma (polígono o círculo) y punto-en-geocerca
    // ---------------------------------------------------------------------

    /**
     * Centro y radio (m) de una geocerca tipo círculo. El formato exacto de
     * `points` para círculos en GET /api/v3/geofences no está confirmado
     * (PILOT guarda "lat;lon;radio" internamente), por eso se aceptan las
     * variantes razonables: [lat, lon, r], [[lat, lon, r]], [[lat, lon]] con
     * radio aparte, [{lat, lon}] o el string "lat;lon;r". null si no se
     * reconoce: el llamador salta la geocerca en vez de fallar.
     */
    _geofenceCircle: function (g) {
        var raw = g && g.points;
        var lat = NaN, lon = NaN, r = NaN;
        if (typeof raw === 'string') {
            var p = raw.split(/[;,|]/);
            lat = Number(p[0]); lon = Number(p[1]); r = Number(p[2]);
        } else if (Array.isArray(raw) && raw.length) {
            var first = raw[0];
            if (Array.isArray(first)) {
                lat = Number(first[0]); lon = Number(first[1]); r = Number(first[2]);
            } else if (first && typeof first === 'object') {
                lat = Number(first.lat); lon = Number(first.lon != null ? first.lon : first.lng);
                r = Number(first.radius != null ? first.radius : first.r);
            } else {
                lat = Number(raw[0]); lon = Number(raw[1]); r = Number(raw[2]);
            }
        }
        if (!(r > 0)) {
            r = Number(g.radius != null ? g.radius : (g.r != null ? g.r : g.width));
        }
        if (!isFinite(lat) || !isFinite(lon) || !(r > 0)) { return null; }
        return { lat: lat, lon: lon, r: r };
    },

    /**
     * Forma lista para comparar de una geocerca: { kind:'poly', pts, bbox } o
     * { kind:'circle', lat, lon, r }; null si no es un área usable (línea,
     * puntos insuficientes, formato desconocido). Se memoriza en el propio
     * objeto de la geocerca: con ~160 geocercas y ~1350 vehículos, parsear en
     * cada comparación sería el costo dominante.
     */
    _lopGeofenceShape: function (g) {
        if (!g) { return null; }
        if (g._lopShape !== undefined) { return g._lopShape; }
        var shape = null;
        if (g.type === 'circle') {
            var c = this._geofenceCircle(g);
            if (c) { shape = { kind: 'circle', lat: c.lat, lon: c.lon, r: c.r }; }
        } else if (g.type !== 'line') {
            var pts = this._geofencePolygonPoints(g);
            if (pts && pts.length >= 3) {
                var b = { minLat: 90, maxLat: -90, minLon: 180, maxLon: -180 };
                for (var i = 0; i < pts.length; i++) {
                    if (pts[i][0] < b.minLat) { b.minLat = pts[i][0]; }
                    if (pts[i][0] > b.maxLat) { b.maxLat = pts[i][0]; }
                    if (pts[i][1] < b.minLon) { b.minLon = pts[i][1]; }
                    if (pts[i][1] > b.maxLon) { b.maxLon = pts[i][1]; }
                }
                shape = { kind: 'poly', pts: pts, bbox: b };
            }
        }
        g._lopShape = shape;
        return shape;
    },

    /** true si (lat, lon) cae dentro de la geocerca `g` (polígono o círculo). */
    _pointInGeofence: function (lat, lon, g) {
        var s = this._lopGeofenceShape(g);
        if (!s) { return false; }
        if (s.kind === 'circle') {
            return this._lopDistanceM(lat, lon, s.lat, s.lon) <= s.r;
        }
        var b = s.bbox;
        if (lat < b.minLat || lat > b.maxLat || lon < b.minLon || lon > b.maxLon) { return false; }
        return this._pointInPolygon(lat, lon, s.pts);
    },

    /**
     * Resumen de las geocercas cargadas por grupo, solo con el flag de debug:
     * cuántas son polígono, círculo o línea, cuántas se pudieron interpretar
     * y la forma cruda de `points` de una muestra. Es el dato que falta para
     * diagnosticar un grupo que nunca da match (p. ej. bases definidas como
     * círculos con un formato de `points` distinto al esperado).
     */
    _lopLogGeofenceShapes: function (geofences) {
        var groups = {};
        for (var i = 0; i < geofences.length; i++) {
            var g = geofences[i];
            var key = g.group_name || '(sin grupo)';
            var e = groups[key] = groups[key] || { total: 0, types: {}, usable: 0, sample: null };
            e.total++;
            e.types[g.type || '?'] = (e.types[g.type || '?'] || 0) + 1;
            if (this._lopGeofenceShape(g)) { e.usable++; }
            else if (!e.sample) {
                var raw = JSON.stringify(g.points);
                e.sample = { type: g.type, points: raw && raw.length > 160 ? raw.slice(0, 160) + '…' : raw };
            }
        }
        Store.promatic_dashboard_enhancer.Module.debugLog('geocercas por grupo (tipos, interpretables, muestra no interpretada):', groups);
    },

    // ---------------------------------------------------------------------
    // 1. Vehículos disponibles por sucursal / % estacionados
    // ---------------------------------------------------------------------

    /**
     * Carga (si falta) las geocercas y pinta las dos cards de sucursales.
     * Reutiliza el match del mapa de flota (config.branches.clientMap: qué
     * carpeta de flota usa qué grupos de geocercas) y su caché
     * _lastGeofences; no hace requests propios aparte de ese GET si todavía
     * no se cargó.
     */
    loadLopBranches: function () {
        var me = this;
        var cfg = (me.config && me.config.branches) || (me.DEFAULT_CONFIG.branches || {});
        if ((cfg.clientMap || []).length === 0) {
            var msg = this._lopDevMarkup(l('Sin sucursales configuradas para esta cuenta.'));
            this.updateCardBody(this.LOP_CARD_IDS.sucursales, msg, 0, true);
            this.updateCardBody(this.LOP_CARD_IDS.estacionados, msg, 0, true);
            return;
        }
        var go = function () {
            try {
                me._lopBranchData = me._lopComputeBranches();
                me.renderLopBranches();
            } catch (err) {
                var code = me.widgetErrorCode('LOP-SUCURSALES', err);
                var m = l('No se pudo calcular las sucursales.') + ' (' + code + ')';
                me.updateCardBody(me.LOP_CARD_IDS.sucursales, m, 0, true);
                me.updateCardBody(me.LOP_CARD_IDS.estacionados, m, 0, true);
            }
        };
        if (this._lastGeofences) { go(); return; }
        this.withFleetVehicleIds(function () {
            me.loadBranchGeofences(function (errCode) {
                if (errCode) {
                    var m = l('No se pudieron cargar las geocercas.') + ' (' + errCode + ')';
                    me.updateCardBody(me.LOP_CARD_IDS.sucursales, m, 0, true);
                    me.updateCardBody(me.LOP_CARD_IDS.estacionados, m, 0, true);
                    return;
                }
                go();
            });
        });
    },

    /**
     * Presencia por sucursal. Para CADA vehículo del alcance (no solo los
     * apagados, a diferencia del tooltip del mapa) se busca la geocerca de los
     * grupos de su cliente que contiene su última posición; el estado
     * (movimiento / estacionado / sin señal) sale del propio árbol Online. Se
     * usa el texto de estado y no `firing`: en vehículos cuyo sensor de
     * ignición está fijo en "encendido" no distinguiría nada.
     *
     * Devuelve { rows, totals } con una fila por geocerca con al menos un
     * vehículo; totals separa los vehículos sin cliente mapeado, sin posición,
     * fuera de toda sucursal y dentro de alguna.
     */
    _lopComputeBranches: function () {
        var onlineTree = this.getOnlineTree();
        var records = onlineTree ? this.getScopedFleetRecords(onlineTree) : [];
        var geofences = this._lastGeofences || [];
        if (!this._lopGeoLogged) {
            this._lopGeoLogged = true;
            this._lopLogGeofenceShapes(geofences);
        }

        var byGroup = {};
        for (var gi = 0; gi < geofences.length; gi++) {
            var g = geofences[gi];
            if (g && g.group_name && this._lopGeofenceShape(g)) {
                (byGroup[g.group_name] = byGroup[g.group_name] || []).push(g);
            }
        }

        var perFence = {};
        var totals = { scope: 0, unmapped: 0, noCoords: 0, outside: 0, inside: 0 };
        var unmatchedSamples = [];

        for (var i = 0; i < records.length; i++) {
            var rec = records[i];
            if (!this._recordField(rec, 'agentid')) { continue; }
            totals.scope++;
            var entry = this._clientMapEntryForRecord(rec);
            if (!entry || !entry.groupNames || entry.groupNames.length === 0) { totals.unmapped++; continue; }
            var ll = this._recordLatLon(rec);
            if (!ll) { totals.noCoords++; continue; }

            var hit = null;
            for (var n = 0; n < entry.groupNames.length && !hit; n++) {
                var list = byGroup[entry.groupNames[n]] || [];
                for (var j = 0; j < list.length; j++) {
                    if (this._pointInGeofence(ll[0], ll[1], list[j])) { hit = list[j]; break; }
                }
            }
            if (!hit) {
                totals.outside++;
                if (unmatchedSamples.length < 5) { unmatchedSamples.push({ ll: ll, groups: entry.groupNames }); }
                continue;
            }
            totals.inside++;
            var online = !!this._recordField(rec, 'is_server_online');
            var moving = online && String(this._recordField(rec, 'status') || '').indexOf('movimiento') !== -1;
            var row = perFence[hit.id] = perFence[hit.id] || {
                id: hit.id, name: hit.name || String(hit.id), group: hit.group_name,
                present: 0, parked: 0, moving: 0, offline: 0
            };
            row.present++;
            if (!online) { row.offline++; } else if (moving) { row.moving++; } else { row.parked++; }
        }

        var rows = [];
        for (var k in perFence) {
            if (perFence.hasOwnProperty(k)) {
                perFence[k].pct = perFence[k].present > 0 ? Math.round(perFence[k].parked / perFence[k].present * 100) : 0;
                rows.push(perFence[k]);
            }
        }
        rows.sort(function (a, b) { return b.present - a.present || (a.name < b.name ? -1 : 1); });

        Store.promatic_dashboard_enhancer.Module.debugLog('sucursales LOP: ' + totals.scope + ' vehículos en alcance, ' +
            totals.inside + ' dentro de una sucursal (' + rows.length + ' sucursales con vehículos), ' +
            totals.outside + ' fuera de toda sucursal, ' + totals.unmapped + ' sin cliente mapeado, ' +
            totals.noCoords + ' sin posición');
        if (totals.inside === 0 && unmatchedSamples.length > 0) {
            this._lopLogNearestGeofence(unmatchedSamples, byGroup);
        }
        return { rows: rows, totals: totals };
    },

    /**
     * Diagnóstico de "ningún vehículo cae en ninguna sucursal": para unos
     * pocos vehículos sin match, distancia a la geocerca más cercana por
     * centroide (o centro del círculo) con las coordenadas en orden normal y
     * con lat/lon invertidos. Distancias de decenas de metros apuntan a un
     * problema de forma o radio de la geocerca; cientos de km apuntan a un
     * grupo equivocado; si la invertida es la corta, la API devuelve lon/lat.
     */
    _lopLogNearestGeofence: function (samples, byGroup) {
        var me = this;
        var out = [];
        var centroid = function (g) {
            var s = me._lopGeofenceShape(g);
            if (s.kind === 'circle') { return [s.lat, s.lon]; }
            return [(s.bbox.minLat + s.bbox.maxLat) / 2, (s.bbox.minLon + s.bbox.maxLon) / 2];
        };
        for (var i = 0; i < samples.length; i++) {
            var s = samples[i], best = null, bestSw = null;
            for (var gi = 0; gi < s.groups.length; gi++) {
                var list = byGroup[s.groups[gi]] || [];
                for (var j = 0; j < list.length; j++) {
                    var c = centroid(list[j]);
                    var d = me._lopDistanceM(s.ll[0], s.ll[1], c[0], c[1]);
                    var dsw = me._lopDistanceM(s.ll[0], s.ll[1], c[1], c[0]);
                    if (best === null || d < best.m) { best = { m: Math.round(d), name: list[j].name, type: list[j].type }; }
                    if (bestSw === null || dsw < bestSw) { bestSw = Math.round(dsw); }
                }
            }
            out.push({ veh: s.ll, masCercana: best, distInvertidaM: bestSw });
        }
        Store.promatic_dashboard_enhancer.Module.debugLog('sucursales LOP: sin ningún match; geocerca más cercana de 5 vehículos de muestra:', out);
    },

    renderLopBranches: function () {
        var data = this._lopBranchData;
        if (!data) { return; }
        var ids = this.LOP_CARD_IDS;
        var esc = Ext.String.htmlEncode;
        var t = data.totals;
        var cfg = this._lopCfg('branches');

        if (t.scope === 0) {
            var emptyMsg = this._lopNote(l('Sin vehículos en el alcance actual.'));
            this.updateCardBody(ids.sucursales, emptyMsg, 0, true);
            this.updateCardBody(ids.estacionados, emptyMsg, 0, true);
            return;
        }

        var coverage = this._lopNote(
            l('En sucursal') + ': ' + t.inside + ' ' + l('de') + ' ' + t.scope + ' ' + l('vehículos') +
            (t.outside ? ' · ' + t.outside + ' ' + l('fuera de toda sucursal') : '') +
            (t.unmapped ? ' · ' + t.unmapped + ' ' + l('de flotas sin sucursales configuradas') : '') +
            (t.noCoords ? ' · ' + t.noCoords + ' ' + l('sin posición') : ''));

        if (data.rows.length === 0) {
            var none = Ext.DomHelper.markup({ cls: 'promatic_dashboard_enhancer-lop-wrap', cn: [
                { cls: 'promatic_dashboard_enhancer-lop-empty', html: l('Ningún vehículo dentro de una sucursal ahora mismo.') },
                coverage
            ] });
            this.updateCardBody(ids.sucursales, none, 0, true);
            this.updateCardBody(ids.estacionados, none, 0, true);
            return;
        }

        var shown = data.rows.slice(0, cfg.rankCount * 3);
        var num = function (v) { return { tag: 'td', cls: 'promatic_dashboard_enhancer-lop-n', html: String(v) }; };
        var trs = shown.map(function (r) {
            return { tag: 'tr', cn: [
                { tag: 'td', html: esc(r.name), title: esc(r.group || '') },
                num(r.present), num(r.parked), num(r.moving), num(r.offline)
            ] };
        });
        this.updateCardBody(ids.sucursales, Ext.DomHelper.markup({ cls: 'promatic_dashboard_enhancer-lop-wrap', cn: [
            { cls: 'promatic_dashboard_enhancer-lop-scroll', cn: [{ tag: 'table', cls: 'promatic_dashboard_enhancer-lop-table', cn: [
                { tag: 'thead', cn: [{ tag: 'tr', cn: [
                    { tag: 'th', html: l('Sucursal') }, { tag: 'th', cls: 'promatic_dashboard_enhancer-lop-n', html: l('Presentes') },
                    { tag: 'th', cls: 'promatic_dashboard_enhancer-lop-n', html: l('Disponibles') },
                    { tag: 'th', cls: 'promatic_dashboard_enhancer-lop-n', html: l('En ruta') },
                    { tag: 'th', cls: 'promatic_dashboard_enhancer-lop-n', html: l('Sin señal') }
                ] }] },
                { tag: 'tbody', cn: trs }
            ] }] },
            coverage
        ] }), 0, true);

        var bars = data.rows.slice(0, cfg.rankCount).map(function (r) {
            return { cls: 'promatic_dashboard_enhancer-lop-bar', cn: [
                { cls: 'promatic_dashboard_enhancer-lop-bar__label', html: esc(r.name), title: esc(r.name) },
                { cls: 'promatic_dashboard_enhancer-lop-bar__track', cn: [
                    { cls: 'promatic_dashboard_enhancer-lop-bar__fill', style: 'width:' + r.pct + '%' }
                ] },
                { cls: 'promatic_dashboard_enhancer-lop-bar__val', html: r.pct + '% <span>(' + r.parked + '/' + r.present + ')</span>' }
            ] };
        });
        this.updateCardBody(ids.estacionados, Ext.DomHelper.markup({ cls: 'promatic_dashboard_enhancer-lop-wrap', cn: bars.concat([
            this._lopNote(l('Estacionado = en línea y sin movimiento, sobre los vehículos presentes en la sucursal.'))
        ]) }), 0, true);
    },

    // ---------------------------------------------------------------------
    // Reportes pesados en lotes (combustible, peajes)
    // ---------------------------------------------------------------------

    /**
     * POST a reports.php con un cuerpo estándar (buildReportBody) y explode
     * opcional. explode=3 ("No dividir") pide una fila por vehículo en toda la
     * ventana en vez de una por día, lo que reduce el payload y evita sumar
     * subtotales diarios con totales.
     */
    _lopFetchReport: function (reportType, csv, start, stop, timeoutMs, explode) {
        var body = this.buildReportBody(reportType, csv, start, stop);
        if (explode) { body = body.replace(/(^|&)explode=\d+/, '$1explode=' + encodeURIComponent(explode)); }
        var ctrl = new AbortController();
        var to = setTimeout(function () { ctrl.abort(); }, timeoutMs);
        return fetch('/backend/ax/reports.php', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: body,
            signal: ctrl.signal
        }).then(function (resp) {
            if (!resp.ok) { throw new Error('HTTP ' + resp.status); }
            return resp.json();
        }).finally(function () { clearTimeout(to); });
    },

    /**
     * Ejecuta runOne(sliceIds) sobre lotes de ids, UNO A LA VEZ y con pausa
     * entre lotes (las ráfagas hicieron que PILOT cerrara la sesión). Dos
     * lotes seguidos que fallan cortan la cola: si PILOT rechaza o está
     * saturado, insistir solo empeora. onProgress(done, total, partial) se
     * llama tras cada lote para pintar resultados parciales. isStale() corta
     * si arrancó una carga más nueva.
     * Resuelve { resps, failed, done, total, aborted }.
     */
    _lopRunBatches: function (ids, runOne, opts) {
        var total = ids.length, done = 0, failed = 0, consecutive = 0, aborted = false;
        var resps = [];
        var queue = ids.slice();
        return new Promise(function (resolve) {
            var step = function () {
                if (queue.length === 0 || (opts.isStale && opts.isStale())) { resolve({ resps: resps, failed: failed, done: done, total: total, aborted: aborted }); return; }
                var slice = queue.splice(0, opts.batchSize);
                runOne(slice).then(function (resp) {
                    consecutive = 0;
                    resps.push(resp);
                }).catch(function (err) {
                    failed++;
                    consecutive++;
                    console.warn('[promatic_dashboard_enhancer] lote de reporte falló (' + (err && err.message ? err.message : err) + ')');
                }).then(function () {
                    done += slice.length;
                    if (opts.onProgress) { opts.onProgress(done, total, resps); }
                    if (consecutive >= 2) {
                        aborted = true;
                        console.warn('[promatic_dashboard_enhancer] 2 lotes seguidos fallaron: se corta la cola (' +
                            queue.length + ' vehículos sin consultar) para no arriesgar la sesión con PILOT.');
                        resolve({ resps: resps, failed: failed, done: done, total: total, aborted: true });
                        return;
                    }
                    setTimeout(step, opts.pauseMs);
                });
            };
            step();
        });
    },

    /** Ids a consultar: vehículos del alcance con movimiento reciente, acotados a maxVehicles. */
    _lopCandidateIds: function (days) {
        var onlineTree = this.getOnlineTree();
        if (!onlineTree) { return { ids: [], scope: 0 }; }
        var scope = this.getFleetVehicleIds(onlineTree).length;
        var ids = this.getRecentlyActiveIds(onlineTree, days);
        var max = this._lopCfg('batch').maxVehicles;
        if (ids.length > max) { ids = ids.slice(0, max); }
        return { ids: ids, scope: scope };
    },

    _lopCacheGet: function (key, sig) {
        var c = this._lopCache && this._lopCache[key];
        var ttl = this._lopCfg('batch').cacheMinutes * 60000;
        return (c && c.sig === sig && (Date.now() - c.ts) < ttl) ? c.value : null;
    },
    _lopCacheSet: function (key, sig, value) {
        if (!this._lopCache) { this._lopCache = {}; }
        this._lopCache[key] = { sig: sig, ts: Date.now(), value: value };
    },

    /** Resumen de la forma de una respuesta de reporte para el log de debug. */
    _lopDescribeResp: function (resp) {
        var rows = this._lopCollectRows(resp && resp.data);
        var hdr = null;
        if (rows.length) { hdr = this._lopColumnNames(resp, rows[0].cells.length); }
        return {
            keys: resp && typeof resp === 'object' ? Object.keys(resp) : typeof resp,
            success: resp && resp.success, msg: resp && resp.msg,
            filas: rows.length, encabezados: hdr || (resp && resp.headers),
            muestra: rows.slice(0, 2).map(function (r) { return r.cells; })
        };
    },

    // ---------------------------------------------------------------------
    // 3. Rendimiento de combustible (report_type=6)
    // ---------------------------------------------------------------------

    /**
     * Parser DEFENSIVO del reporte de combustible por norma: el schema de
     * report_type=6 no está documentado. Se identifican las columnas de
     * distancia y de combustible por el texto de sus encabezados, que llegan
     * en el idioma de la sesión (español o inglés) (o por
     * config.lop.fuel.distCol/fuelCol) y se suma por vehículo. Devuelve
     * { recognized, reason, rows:[{name, km, liters}], cols }.
     */
    _lopParseFuelResp: function (resps, cfg) {
        var agg = {}, order = [], cols = null, anyRows = false, reason = '';
        for (var r = 0; r < resps.length; r++) {
            var rows = this._lopCollectRows(resps[r] && resps[r].data);
            if (rows.length === 0) { continue; }
            anyRows = true;
            var names = this._lopColumnNames(resps[r], rows[0].cells.length);
            var di = cfg.distCol != null ? Number(cfg.distCol) :
                this._lopFindCol(names, /dist|mileage|kilomet|\bkm\b|пробег|recorr/i, /100|avg|average|prom|средн/i);
            var fi = cfg.fuelCol != null ? Number(cfg.fuelCol) :
                this._lopFindCol(names, /fuel|consum|rashod|combust|litr|liter|volume|расход|топлив/i, /100|avg|average|prom|средн|rate|cost|price|precio|importe|sum\b/i);
            if (di < 0 || fi < 0 || di === fi) {
                reason = 'no se identificaron las columnas de distancia y combustible (encabezados: ' + JSON.stringify(names) + ')';
                continue;
            }
            cols = { dist: di, fuel: fi, names: names };
            for (var i = 0; i < rows.length; i++) {
                var cells = rows[i].cells;
                var nm = rows[i].veh;
                if (/^(total|итого|всего|all)\b/i.test(nm)) { continue; }
                var km = this._lopNum(cells[di]);
                var lt = this._lopNum(cells[fi]);
                if (km === null && lt === null) { continue; }
                if (!agg[nm]) { agg[nm] = { name: nm, km: 0, liters: 0, hasKm: false, hasLt: false }; order.push(nm); }
                if (km !== null) { agg[nm].km += km; agg[nm].hasKm = true; }
                if (lt !== null) { agg[nm].liters += lt; agg[nm].hasLt = true; }
            }
        }
        if (!anyRows) { return { recognized: false, reason: 'la respuesta no trae filas', rows: [] }; }
        if (!cols) { return { recognized: false, reason: reason, rows: [] }; }
        var out = order.map(function (k) { return { name: agg[k].name, km: agg[k].hasKm ? agg[k].km : null, liters: agg[k].hasLt ? agg[k].liters : null }; });
        return { recognized: out.length > 0, reason: out.length ? '' : 'sin filas con datos numéricos', rows: out, cols: cols };
    },

    /**
     * Combustible: report_type=6 en lotes sobre vehículos con movimiento
     * reciente. Devuelve una Promise que siempre resuelve (nunca rechaza), para
     * poder encadenar el siguiente widget pesado. Con sensor de tanque
     * (semanticid 2, p. ej. FuelLevel2) se podría contrastar el consumo por
     * norma con el real vía report_type=16; no se implementa acá.
     */
    loadLopFuel: function (force) {
        var me = this;
        var id = this.LOP_CARD_IDS.combustible;
        var cfg = this._lopCfg('fuel');
        var bcfg = this._lopCfg('batch');
        var cand = this._lopCandidateIds(cfg.windowDays);
        if (cand.ids.length === 0) {
            this.updateCardBody(id, this._lopNote(l('Sin vehículos con movimiento reciente en el alcance.')), 0, true);
            return Promise.resolve();
        }
        var sig = cand.scope + ':' + cfg.windowDays;
        var cached = force ? null : this._lopCacheGet('fuel', sig);
        if (cached) { this._lopFuel = cached; this.renderLopFuel(); return Promise.resolve(); }

        var nonce = (this._lopFuelNonce = (this._lopFuelNonce || 0) + 1);
        var stop = new Date();
        var start = new Date();
        start.setDate(start.getDate() - cfg.windowDays);
        var plan = { queried: cand.ids.length, scope: cand.scope };

        return this._lopRunBatches(cand.ids, function (slice) {
            return me._lopFetchReport(6, slice.join(','), start, stop, bcfg.batchTimeoutMs, cfg.explode);
        }, {
            batchSize: bcfg.batchSize, pauseMs: bcfg.batchPauseMs,
            isStale: function () { return nonce !== me._lopFuelNonce; },
            onProgress: function (done, total) {
                if (!me._lopFuel) {
                    me.updateCardBody(id, me._lopNote(l('Cargando combustible…') + ' ' + done + '/' + total), 0, true);
                }
            }
        }).then(function (res) {
            if (nonce !== me._lopFuelNonce) { return; }
            if (res.resps.length) {
                Store.promatic_dashboard_enhancer.Module.debugLog('combustible (report_type=6), forma de la 1.ª respuesta:', me._lopDescribeResp(res.resps[0]));
            }
            var parsed = me._lopParseFuelResp(res.resps, cfg);
            if (!parsed.recognized) {
                Store.promatic_dashboard_enhancer.Module.debugLog('combustible: respuesta no reconocida — ' + parsed.reason);
                me._lopFuel = null;
                me.updateCardBody(id, me._lopDevMarkup(res.resps.length === 0
                    ? l('Combustible: el reporte no respondió.') : l('Combustible: formato de reporte aún no reconocido.')), 0, true);
                return;
            }
            var groupOf = me._lopGroupByName();
            parsed.rows.forEach(function (row) { row.group = groupOf[row.name] || ''; });
            var analysis = me._lopFuelAnalysis(parsed.rows, cfg);
            me._lopFuel = { analysis: analysis, plan: plan, failed: res.failed, aborted: res.aborted, cols: parsed.cols, days: cfg.windowDays };
            me._lopCacheSet('fuel', sig, me._lopFuel);
            Store.promatic_dashboard_enhancer.Module.debugLog('combustible: ' + parsed.rows.length + ' vehículos con fila, ' +
                analysis.eligible.length + ' elegibles, ' + analysis.noNorm + ' sin norma de consumo, ' + analysis.lowKm +
                ' bajo ' + cfg.minKm + ' km, mediana ' + (analysis.fleetMedian === null ? 'N/D' : analysis.fleetMedian.toFixed(1)) +
                ' L/100 km, ' + analysis.flagged + ' en sobreconsumo; columnas', parsed.cols);
            me.renderLopFuel();
        }).catch(function (err) {
            me.updateCardBody(id, l('No se pudo cargar el combustible.') + ' (' + me.widgetErrorCode('LOP-COMBUSTIBLE', err) + ')', 0, true);
        });
    },

    /** nombre de vehículo → nombre de su carpeta, desde el árbol Online (para cohortes de comparación). */
    _lopGroupByName: function () {
        var onlineTree = this.getOnlineTree();
        var map = {};
        if (!onlineTree) { return map; }
        var records = this.getScopedFleetRecords(onlineTree);
        for (var i = 0; i < records.length; i++) {
            var nm = this._recordField(records[i], 'name');
            if (!nm) { continue; }
            var grp = this._recordField(records[i], 'group');
            if (!grp && records[i].parentNode && records[i].parentNode.get) {
                grp = records[i].parentNode.get('text') || records[i].parentNode.get('name');
            }
            map[String(nm)] = grp ? String(grp) : '';
        }
        return map;
    },

    renderLopFuel: function () {
        var d = this._lopFuel;
        var id = this.LOP_CARD_IDS.combustible;
        if (!d) { return; }
        var a = d.analysis, cfg = this._lopCfg('fuel'), esc = Ext.String.htmlEncode, me = this;
        var mode = this._lopFuelMode || 'rate';

        if (a.eligible.length === 0) {
            this.updateCardBody(id, Ext.DomHelper.markup({ cls: 'promatic_dashboard_enhancer-lop-wrap', cn: [
                { cls: 'promatic_dashboard_enhancer-lop-empty', html: l('Ningún vehículo con consumo por norma y recorrido suficiente en el período.') },
                this._lopNote(a.noNorm + ' ' + l('sin norma de consumo (N/D)') + ' · ' + a.lowKm + ' ' + l('con menos de') + ' ' + cfg.minKm + ' km')
            ] }), 0, true);
            return;
        }

        var list = a.eligible.slice();
        if (mode === 'liters') { list.sort(function (x, y) { return y.liters - x.liters; }); }
        else { list.sort(function (x, y) { return y.lPer100 - x.lPer100; }); }
        list = list.slice(0, cfg.rankCount);

        var trs = list.map(function (e) {
            return { tag: 'tr', cls: e.over ? 'promatic_dashboard_enhancer-lop-row--bad' : '', cn: [
                { tag: 'td', html: esc(me.displayName(e.name)), title: esc(e.group) },
                { tag: 'td', cls: 'promatic_dashboard_enhancer-lop-n', html: me._lopFmt(e.liters, 0) + ' L' },
                { tag: 'td', cls: 'promatic_dashboard_enhancer-lop-n', html: me._lopFmt(e.km, 0) },
                { tag: 'td', cls: 'promatic_dashboard_enhancer-lop-n', html: me._lopFmt(e.lPer100, 1) },
                { tag: 'td', cls: 'promatic_dashboard_enhancer-lop-n', html: e.ratio === null ? l('N/D') : ('+' + Math.round((e.ratio - 1) * 100) + '%').replace('+-', '-') }
            ] };
        });

        this.updateCardBody(id, Ext.DomHelper.markup({ cls: 'promatic_dashboard_enhancer-lop-wrap', cn: [
            { cls: 'promatic_dashboard_enhancer-lop-boxes', cn: [
                this._lopBox(String(a.flagged), l('en sobreconsumo'), a.flagged ? 'bad' : 'ok'),
                this._lopBox(this._lopFmt(a.fleetMedian, 1), l('mediana L/100 km'), 'neutral'),
                this._lopBox(this._lopFmt(a.totalLiters, 0), l('litros (norma)'), 'neutral')
            ] },
            { cls: 'promatic_dashboard_enhancer-lop-chips', cn: [
                this._lopChip('fuel-mode', 'rate', l('Por L/100 km'), mode === 'rate'),
                this._lopChip('fuel-mode', 'liters', l('Por litros'), mode === 'liters')
            ] },
            { cls: 'promatic_dashboard_enhancer-lop-scroll', cn: [{ tag: 'table', cls: 'promatic_dashboard_enhancer-lop-table', cn: [
                { tag: 'thead', cn: [{ tag: 'tr', cn: [
                    { tag: 'th', html: l('Vehículo') }, { tag: 'th', cls: 'promatic_dashboard_enhancer-lop-n', html: l('Litros') },
                    { tag: 'th', cls: 'promatic_dashboard_enhancer-lop-n', html: 'km' },
                    { tag: 'th', cls: 'promatic_dashboard_enhancer-lop-n', html: 'L/100' },
                    { tag: 'th', cls: 'promatic_dashboard_enhancer-lop-n', html: l('vs mediana') }
                ] }] },
                { tag: 'tbody', cn: trs }
            ] }] },
            this._lopNote(l('Cobertura') + ': ' + a.eligible.length + ' ' + l('de') + ' ' + d.plan.queried + ' ' + l('vehículos consultados') +
                ' (' + l('alcance') + ' ' + d.plan.scope + ': ' + l('solo con movimiento reciente') + '; ' + a.noNorm + ' ' + l('sin norma de consumo') + ', ' + a.lowKm + ' ' + l('con menos de') + ' ' + cfg.minKm + ' km). ' +
                l('Sobreconsumo') + ' = +' + cfg.overconsumptionPct + '% ' + l('sobre la mediana de su carpeta') + ' · ' + d.days + ' ' + l('días') +
                (d.failed ? ' · ' + d.failed + ' ' + l('lotes fallidos') : '') + (d.aborted ? ' (' + l('carga cortada') + ')' : ''))
        ] }), 0, true);
    },

    // ---------------------------------------------------------------------
    // 5. TAG / peajes (report_type=96, sin probar en este proyecto)
    // ---------------------------------------------------------------------

    /**
     * Parser DEFENSIVO de Toll Roads: una fila = una pasada por pórtico. Se
     * cuenta por vehículo y, si hay una columna de monto (por encabezado), se
     * suma. Los textos pueden traer HTML residual en las columnas de pórtico
     * (se limpia). Devuelve { recognized, reason, rows:[{name, passes,
     * amount|null}] }.
     */
    _lopParseTagResp: function (resps) {
        var agg = {}, order = [], anyRows = false, amountCol = -1, names = null;
        for (var r = 0; r < resps.length; r++) {
            var rows = this._lopCollectRows(resps[r] && resps[r].data);
            if (rows.length === 0) { continue; }
            anyRows = true;
            names = this._lopColumnNames(resps[r], rows[0].cells.length);
            amountCol = this._lopFindCol(names, /sum|cost|amount|price|tarif|monto|importe|valor|total|fee|charge|стоим|сумм|цена/i, /count|cantidad|qty|кол/i);
            for (var i = 0; i < rows.length; i++) {
                var nm = this._lopStripTags(rows[i].veh);
                if (!nm || /^(total|итого|всего)\b/i.test(nm)) { continue; }
                if (!agg[nm]) { agg[nm] = { name: nm, passes: 0, amount: 0, hasAmount: false }; order.push(nm); }
                agg[nm].passes++;
                if (amountCol > 0) {
                    var amt = this._lopNum(rows[i].cells[amountCol], true);
                    if (amt !== null) { agg[nm].amount += amt; agg[nm].hasAmount = true; }
                }
            }
        }
        if (!anyRows) { return { recognized: false, reason: 'la respuesta no trae filas', rows: [], names: names }; }
        var out = order.map(function (k) { return { name: agg[k].name, passes: agg[k].passes, amount: agg[k].hasAmount ? agg[k].amount : null }; });
        return { recognized: out.length > 0, reason: '', rows: out, names: names, amountCol: amountCol };
    },

    loadLopTag: function (force) {
        var me = this;
        var id = this.LOP_CARD_IDS.tag;
        var cfg = this._lopCfg('tag');
        var bcfg = this._lopCfg('batch');
        var cand = this._lopCandidateIds(cfg.windowDays);
        if (cand.ids.length === 0) {
            this.updateCardBody(id, this._lopNote(l('Sin vehículos con movimiento reciente en el alcance.')), 0, true);
            return Promise.resolve();
        }
        var sig = cand.scope + ':' + cfg.windowDays;
        var cached = force ? null : this._lopCacheGet('tag', sig);
        if (cached) { this._lopTag = cached; this.renderLopTag(); return Promise.resolve(); }

        var nonce = (this._lopTagNonce = (this._lopTagNonce || 0) + 1);
        var stop = new Date();
        var start = new Date();
        start.setDate(start.getDate() - cfg.windowDays);

        return this._lopRunBatches(cand.ids, function (slice) {
            return me._lopFetchReport(96, slice.join(','), start, stop, bcfg.batchTimeoutMs, cfg.explode);
        }, {
            batchSize: bcfg.batchSize, pauseMs: bcfg.batchPauseMs,
            isStale: function () { return nonce !== me._lopTagNonce; },
            onProgress: function (done, total) {
                if (!me._lopTag) {
                    me.updateCardBody(id, me._lopNote(l('Cargando peajes…') + ' ' + done + '/' + total), 0, true);
                }
            }
        }).then(function (res) {
            if (nonce !== me._lopTagNonce) { return; }
            if (res.resps.length) {
                Store.promatic_dashboard_enhancer.Module.debugLog('TAG (report_type=96), forma de la 1.ª respuesta:', me._lopDescribeResp(res.resps[0]));
            }
            // success:false (módulo sin habilitar) o ninguna respuesta útil
            // → "En desarrollo", nunca un 0 inventado.
            var usable = res.resps.filter(function (x) { return x && x.success !== false; });
            var parsed = me._lopParseTagResp(usable);
            if (!parsed.recognized) {
                Store.promatic_dashboard_enhancer.Module.debugLog('TAG: sin datos reconocidos — ' + (parsed.reason || 'sin respuestas útiles'));
                me._lopTag = null;
                me.updateCardBody(id, me._lopDevMarkup(l('Peajes (TAG): reporte no disponible o formato aún no reconocido en esta cuenta.')), 0, true);
                return;
            }
            me._lopTag = { rows: parsed.rows.sort(function (a, b) { return (b.amount || 0) - (a.amount || 0) || b.passes - a.passes; }),
                hasAmount: parsed.amountCol > 0 && parsed.rows.some(function (x) { return x.amount !== null; }),
                queried: cand.ids.length, failed: res.failed, aborted: res.aborted, days: cfg.windowDays };
            me._lopCacheSet('tag', sig, me._lopTag);
            Store.promatic_dashboard_enhancer.Module.debugLog('TAG: ' + parsed.rows.length + ' vehículos con pasadas, columna de monto ' +
                (parsed.amountCol > 0 ? parsed.names[parsed.amountCol] : 'no identificada'));
            me.renderLopTag();
        }).catch(function (err) {
            me.updateCardBody(id, l('No se pudo cargar el consumo de TAG.') + ' (' + me.widgetErrorCode('LOP-TAG', err) + ')', 0, true);
        });
    },

    renderLopTag: function () {
        var d = this._lopTag;
        if (!d) { return; }
        var cfg = this._lopCfg('tag'), esc = Ext.String.htmlEncode, me = this;
        var list = d.rows.slice(0, cfg.rankCount);
        var maxPasses = 0;
        d.rows.forEach(function (r) { if (r.passes > maxPasses) { maxPasses = r.passes; } });
        var totalPasses = d.rows.reduce(function (a, r) { return a + r.passes; }, 0);
        var trs = list.map(function (r) {
            var cells = [
                { tag: 'td', html: esc(me.displayName(r.name)) },
                { tag: 'td', cls: 'promatic_dashboard_enhancer-lop-n', html: String(r.passes) }
            ];
            if (d.hasAmount) { cells.push({ tag: 'td', cls: 'promatic_dashboard_enhancer-lop-n', html: me._lopFmt(r.amount, 0) }); }
            return { tag: 'tr', cn: cells };
        });
        var head = [{ tag: 'th', html: l('Vehículo') }, { tag: 'th', cls: 'promatic_dashboard_enhancer-lop-n', html: l('Pasadas') }];
        if (d.hasAmount) { head.push({ tag: 'th', cls: 'promatic_dashboard_enhancer-lop-n', html: l('Monto') }); }
        this.updateCardBody(this.LOP_CARD_IDS.tag, Ext.DomHelper.markup({ cls: 'promatic_dashboard_enhancer-lop-wrap', cn: [
            { cls: 'promatic_dashboard_enhancer-lop-boxes', cn: [
                this._lopBox(String(d.rows.length), l('vehículos con pasadas'), 'neutral'),
                this._lopBox(String(totalPasses), l('pasadas'), 'neutral')
            ] },
            { cls: 'promatic_dashboard_enhancer-lop-scroll', cn: [{ tag: 'table', cls: 'promatic_dashboard_enhancer-lop-table', cn: [
                { tag: 'thead', cn: [{ tag: 'tr', cn: head }] },
                { tag: 'tbody', cn: trs }
            ] }] },
            this._lopNote(l('Consultados') + ' ' + d.queried + ' ' + l('vehículos con movimiento reciente') + ' · ' + d.days + ' ' + l('días') +
                (d.failed ? ' · ' + d.failed + ' ' + l('lotes fallidos') : '') + (d.aborted ? ' (' + l('carga cortada') + ')' : ''))
        ] }), 0, true);
    },

    // ---------------------------------------------------------------------
    // 2. Conducción (Safety Score + infracciones, sin consultas nuevas)
    // ---------------------------------------------------------------------

    /**
     * Guarda por vehículo y por conductor lo que trae el reporte de
     * infracciones (report_type=114), que renderViolationsTrend solo suma en
     * totales de flota. Filas: [veh, grupo, fecha, conductor, km, duración,
     * velocidad, aceleración, frenado, ralentí, giro, cinturón, ...] (un
     * vehículo por día). Conductor "no driver" o vacío se descarta: no es una
     * persona. Se llama desde renderViolationsTrend con la respuesta cruda.
     */
    _lopCacheViolationRows: function (byDate) {
        try {
            this._lopCacheViolationRowsUnsafe(byDate);
        } catch (err) {
            // Dato auxiliar del widget Conducción: nunca debe tumbar la
            // tarjeta de Tendencia de Infracciones.
            this.widgetErrorCode('LOP-VIOLATIONS-CACHE', err);
        }
    },

    _lopCacheViolationRowsUnsafe: function (byDate) {
        var perVeh = {}, perDriver = {};
        var acc = function (map, key, c) {
            var o = map[key] = map[key] || { name: key, dist: 0, speed: 0, accel: 0, braking: 0, idling: 0, turn: 0, seatbelt: 0 };
            o.dist += Number(c[4]) || 0;
            o.speed += Number(c[6]) || 0;
            o.accel += Number(c[7]) || 0;
            o.braking += Number(c[8]) || 0;
            o.idling += Number(c[9]) || 0;
            o.turn += Number(c[10]) || 0;
            o.seatbelt += Number(c[11]) || 0;
            return o;
        };
        for (var range in byDate) {
            if (!byDate.hasOwnProperty(range)) { continue; }
            var rows = byDate[range] || [];
            for (var i = 0; i < rows.length; i++) {
                var c = rows[i];
                if (!c || c.length < 12 || !c[0]) { continue; }
                var v = acc(perVeh, String(c[0]), c);
                var drv = this._lopStripTags(c[3]);
                if (drv && !/^no driver$/i.test(drv) && drv !== '0') {
                    v.driver = drv;
                    acc(perDriver, drv, c);
                }
            }
        }
        this._lastViolationsRows = perVeh;
        this._lastViolationsByDriver = perDriver;
    },

    /**
     * Une las dos fuentes por nombre de vehículo. Fleet ECO aporta frenadas,
     * aceleraciones, tiempo sobre el límite, ralentí y km; infracciones aporta
     * curvas, conductor y el conteo de velocidad. Un campo que la fuente no
     * trae queda en null (N/D), no en 0.
     */
    _lopDrivingRows: function () {
        var eco = this._lastEcoRows || [];
        var viol = this._lastViolationsRows || null;
        var byName = {}, order = [], i;
        for (i = 0; i < eco.length; i++) {
            var e = eco[i];
            byName[e.name] = { name: e.name, group: e.group, dist: e.dist, brake: e.brake, accel: e.accel,
                turn: null, speed: null, overSec: e.over, idleSec: e.idle, score: e.cur, driver: null };
            order.push(e.name);
        }
        if (viol) {
            for (var nm in viol) {
                if (!viol.hasOwnProperty(nm)) { continue; }
                var v = viol[nm];
                var row = byName[nm];
                if (!row) {
                    row = byName[nm] = { name: nm, group: '', dist: v.dist, brake: v.braking, accel: v.accel,
                        turn: null, speed: null, overSec: null, idleSec: null, score: null, driver: null };
                    order.push(nm);
                }
                row.turn = v.turn;
                row.speed = v.speed;
                row.driver = v.driver || null;
            }
        }
        return order.map(function (k) { return byName[k]; });
    },

    _lopDrivingDriverRows: function () {
        var d = this._lastViolationsByDriver;
        if (!d) { return null; }
        var out = [];
        for (var k in d) {
            if (d.hasOwnProperty(k)) {
                out.push({ name: k, dist: d[k].dist, brake: d[k].braking, accel: d[k].accel, turn: d[k].turn, speed: d[k].speed });
            }
        }
        return out;
    },

    renderLopDriving: function () {
        var id = this.LOP_CARD_IDS.conduccion;
        var cfg = this._lopCfg('driving');
        var me = this, esc = Ext.String.htmlEncode;
        var vehRows = this._lopDrivingRows();
        if (vehRows.length === 0) {
            this.updateCardBody(id, this._lopNote(l('Esperando el Safety Score y las infracciones de manejo…')), 0, true);
            return;
        }
        var by = this._lopDrivingBy || 'veh';
        var metric = this._lopDrivingMetric || 'total';
        var drvRows = this._lopDrivingDriverRows();
        if (by === 'driver' && !drvRows) { by = 'veh'; }
        var rows = by === 'driver' ? drvRows : vehRows;
        var rk = this._lopRankDriving(rows, metric, cfg.minKm);
        var top = rk.ranked.slice(0, cfg.rankCount);

        var withEvents = 0, withKm = 0;
        vehRows.forEach(function (r) {
            if (r.dist > 0) { withKm++; }
            if ((r.brake || 0) + (r.accel || 0) + (r.turn || 0) > 0) { withEvents++; }
        });
        var eco = (this._lastEcoRows || []).length;
        var viol = this._lastViolationsRows ? Object.keys(this._lastViolationsRows).length : 0;

        var cell = function (v, hl) {
            return { tag: 'td', cls: 'promatic_dashboard_enhancer-lop-n' + (hl ? ' promatic_dashboard_enhancer-lop-hl' : ''),
                html: v === null || v === undefined ? l('N/D') : me._lopFmt(v, 0) };
        };
        var trs = top.map(function (t, idx) {
            var r = t.row;
            return { tag: 'tr', cn: [
                { tag: 'td', html: (idx + 1) + '. ' + esc(by === 'driver' ? r.name : me.displayName(r.name)) },
                cell(r.brake, metric === 'brake'), cell(r.accel, metric === 'accel'),
                cell(r.turn, metric === 'turn'), cell(r.speed, metric === 'speed'),
                { tag: 'td', cls: 'promatic_dashboard_enhancer-lop-n', html: me._lopFmt(r.dist, 0) },
                { tag: 'td', cls: 'promatic_dashboard_enhancer-lop-n promatic_dashboard_enhancer-lop-hl', html: me._lopFmt(t.index, 1) }
            ] };
        });

        var metrics = [['total', l('Total')], ['brake', l('Frenadas')], ['accel', l('Aceleraciones')], ['turn', l('Curvas')], ['speed', l('Velocidad')]];
        var chips = metrics.map(function (m) { return me._lopChip('drv-metric', m[0], m[1], metric === m[0]); });
        var byChips = [this._lopChip('drv-by', 'veh', l('Vehículos'), by === 'veh')];
        byChips.push(this._lopChip('drv-by', 'driver', l('Conductores'), by === 'driver', !drvRows));

        this.updateCardBody(id, Ext.DomHelper.markup({ cls: 'promatic_dashboard_enhancer-lop-wrap', cn: [
            { cls: 'promatic_dashboard_enhancer-lop-chips', cn: byChips.concat(chips) },
            top.length === 0
                ? { cls: 'promatic_dashboard_enhancer-lop-empty', html: l('Sin datos suficientes para esta métrica.') }
                : { cls: 'promatic_dashboard_enhancer-lop-scroll', cn: [{ tag: 'table', cls: 'promatic_dashboard_enhancer-lop-table', cn: [
                    { tag: 'thead', cn: [{ tag: 'tr', cn: [
                        { tag: 'th', html: by === 'driver' ? l('Conductor') : l('Vehículo') },
                        { tag: 'th', cls: 'promatic_dashboard_enhancer-lop-n', html: l('Frenadas') },
                        { tag: 'th', cls: 'promatic_dashboard_enhancer-lop-n', html: l('Aceler.') },
                        { tag: 'th', cls: 'promatic_dashboard_enhancer-lop-n', html: l('Curvas') },
                        { tag: 'th', cls: 'promatic_dashboard_enhancer-lop-n', html: l('Vel.') },
                        { tag: 'th', cls: 'promatic_dashboard_enhancer-lop-n', html: 'km' },
                        { tag: 'th', cls: 'promatic_dashboard_enhancer-lop-n', html: l('Índice') }
                    ] }] },
                    { tag: 'tbody', cn: trs }
                ] }] },
            this._lopNote(l('Índice = eventos cada 100 km (mín.') + ' ' + cfg.minKm + ' km). ' +
                l('Cobertura') + ': Safety Score ' + eco + ' ' + l('veh.') + ', ' + l('infracciones') + ' ' + viol + ' ' + l('veh.') +
                ' · ' + withEvents + ' ' + l('de') + ' ' + withKm + ' ' + l('con recorrido registran eventos') +
                (rk.excluded ? ' · ' + rk.excluded + ' ' + l('bajo el mínimo de km') : '') +
                (viol === 0 ? ' · ' + l('Curvas y Velocidad: N/D (infracciones sin cargar)') : ''))
        ] }), 0, true);
    },

    // ---------------------------------------------------------------------
    // 4. Kilometraje para mantención (odómetro del árbol Online, sin red)
    // ---------------------------------------------------------------------

    /**
     * Usa current_mileage del record del árbol Online (sin requests). No lee
     * el odómetro CAN/ECU de los sensores (Param389 / Param87 en algunas
     * flotas): su disponibilidad por vehículo no está confirmada, así que
     * donde el árbol no trae odómetro el vehículo figura como N/D.
     */
    renderLopMaintenance: function () {
        var id = this.LOP_CARD_IDS.mantencion;
        var onlineTree = this.getOnlineTree();
        if (!onlineTree) { return; }
        var me = this, esc = Ext.String.htmlEncode;
        var cfg = this._lopCfg('maintenance');
        var records = this.getScopedFleetRecords(onlineTree);
        var rows = [];
        for (var i = 0; i < records.length; i++) {
            if (!this._recordField(records[i], 'agentid')) { continue; }
            var odo = this._lopNum(this._recordField(records[i], 'current_mileage'));
            rows.push({ name: String(this._recordField(records[i], 'name') || ''), odo: odo });
        }
        if (rows.length === 0) {
            this.updateCardBody(id, this._lopNote(l('Sin vehículos en el alcance actual.')), 0, true);
            return;
        }
        var a = this._lopMaintenanceAnalysis(rows, cfg);
        this._lopMaint = { analysis: a, total: rows.length, cfg: cfg };
        Store.promatic_dashboard_enhancer.Module.debugLog('mantención por km: ' + rows.length + ' vehículos, ' + a.rows.length +
            ' con odómetro, ' + a.high + ' sobre ' + cfg.highOdometerKm + ' km, ' + a.due + ' próximos a servicio');

        if (a.rows.length === 0) {
            this.updateCardBody(id, this._lopDevMarkup(l('Mantención por km: los vehículos no informan odómetro en el árbol.')), 0, true);
            return;
        }
        var label = { high: l('Revisión'), due: l('Servicio próximo'), ok: l('OK') };
        var mod = { high: 'bad', due: 'mid', ok: 'ok' };
        var trs = a.rows.slice(0, cfg.rankCount).map(function (r) {
            return { tag: 'tr', cn: [
                { tag: 'td', html: esc(me.displayName(r.name)) },
                { tag: 'td', cls: 'promatic_dashboard_enhancer-lop-n', html: me._lopFmt(r.odo, 0) + ' km' },
                { tag: 'td', cls: 'promatic_dashboard_enhancer-lop-n', html: me._lopFmt(r.toNext, 0) + ' km' },
                { tag: 'td', cn: [{ tag: 'span', cls: 'promatic_dashboard_enhancer-lop-flag promatic_dashboard_enhancer-lop-flag--' + mod[r.status], html: label[r.status] }] }
            ] };
        });
        this.updateCardBody(id, Ext.DomHelper.markup({ cls: 'promatic_dashboard_enhancer-lop-wrap', cn: [
            { cls: 'promatic_dashboard_enhancer-lop-boxes', cn: [
                this._lopBox(String(a.high), l('sugieren revisión'), a.high ? 'bad' : 'ok'),
                this._lopBox(String(a.due), l('servicio próximo'), a.due ? 'mid' : 'ok'),
                this._lopBox(String(a.noData), l('sin odómetro (N/D)'), 'neutral')
            ] },
            { cls: 'promatic_dashboard_enhancer-lop-scroll', cn: [{ tag: 'table', cls: 'promatic_dashboard_enhancer-lop-table', cn: [
                { tag: 'thead', cn: [{ tag: 'tr', cn: [
                    { tag: 'th', html: l('Vehículo') }, { tag: 'th', cls: 'promatic_dashboard_enhancer-lop-n', html: l('Odómetro') },
                    { tag: 'th', cls: 'promatic_dashboard_enhancer-lop-n', html: l('Próx. servicio') }, { tag: 'th', html: l('Estado') }
                ] }] },
                { tag: 'tbody', cn: trs }
            ] }] },
            this._lopNote(l('Cobertura') + ': ' + a.rows.length + ' ' + l('de') + ' ' + rows.length + ' ' + l('con odómetro') + ' · ' +
                l('revisión desde') + ' ' + me._lopFmt(cfg.highOdometerKm, 0) + ' km · ' + l('servicio cada') + ' ' + me._lopFmt(cfg.intervalKm, 0) +
                ' km (' + l('aviso a') + ' ' + me._lopFmt(cfg.warnWithinKm, 0) + ' km)')
        ] }), 0, true);
    },

    // ---------------------------------------------------------------------
    // Piezas de marcado compartidas
    // ---------------------------------------------------------------------

    _lopDevMarkup: function (text) {
        return Ext.DomHelper.markup({ cls: 'promatic_dashboard_enhancer-lop-dev', cn: [
            { tag: 'span', cls: 'promatic_dashboard_enhancer-lop-dev__badge', html: l('EN DESARROLLO') },
            { tag: 'div', html: text }
        ] });
    },

    _lopNote: function (text) {
        return { cls: 'promatic_dashboard_enhancer-lop-note', html: text };
    },

    _lopBox: function (value, label, mod) {
        return { cls: 'promatic_dashboard_enhancer-lop-box promatic_dashboard_enhancer-lop-box--' + mod, cn: [
            { cls: 'promatic_dashboard_enhancer-lop-box__v', html: value },
            { cls: 'promatic_dashboard_enhancer-lop-box__l', html: label }
        ] };
    },

    _lopChip: function (group, value, label, on, disabled) {
        return { tag: 'span', cls: 'promatic_dashboard_enhancer-lop-chip' + (on ? ' promatic_dashboard_enhancer-lop-chip--on' : '') +
            (disabled ? ' promatic_dashboard_enhancer-lop-chip--off' : ''),
            'data-lop-chip': group, 'data-lop-value': value, html: label };
    },

    /**
     * Click delegado de los chips de los widgets LOP (modo de ranking). Se
     * bindea una vez sobre el panel raíz; no toca los handlers del resto.
     */
    _lopBindClicks: function () {
        var me = this;
        this._lopStarted = true;
        var panel = Ext.getCmp('promatic_dashboard_enhancer-panel-root');
        var el = panel && panel.getEl && panel.getEl();
        if (!el || el._lopBound) { return; }
        el._lopBound = true;
        el.on('click', function (e) {
            var chip = e.getTarget('[data-lop-chip]', 4, true);
            if (!chip || chip.hasCls('promatic_dashboard_enhancer-lop-chip--off')) { return; }
            var group = chip.getAttribute('data-lop-chip');
            var value = chip.getAttribute('data-lop-value');
            if (group === 'drv-metric') { me._lopDrivingMetric = value; me.renderLopDriving(); }
            else if (group === 'drv-by') { me._lopDrivingBy = value; me.renderLopDriving(); }
            else if (group === 'fuel-mode') { me._lopFuelMode = value; me.renderLopFuel(); }
        });
    },

    // ---------------------------------------------------------------------
    // Exportador y Golden Report
    // ---------------------------------------------------------------------

    _LOP_EXPORTS: {
        lop_sucursales: 'Vehículos por Sucursal',
        lop_conduccion: 'Conducción',
        lop_combustible: 'Rendimiento de Combustible',
        lop_mantencion: 'Kilometraje para Mantención',
        lop_tag: 'Consumo de TAG'
    },

    _lopIsExport: function (which) { return this._LOP_EXPORTS.hasOwnProperty(which); },

    _lopExportTitle: function (which) {
        return this._lopIsExport(which) ? l(this._LOP_EXPORTS[which]) : null;
    },

    /** Agrega al selector del exportador las opciones LOP (idempotente; solo se llama desde la vista LOP). */
    _lopEnsureExportOptions: function () {
        var sel = document.getElementById('promatic_dashboard_enhancer-export-widget');
        if (!sel) { return; }
        for (var k in this._LOP_EXPORTS) {
            if (!this._LOP_EXPORTS.hasOwnProperty(k)) { continue; }
            var exists = false;
            for (var i = 0; i < sel.options.length; i++) { if (sel.options[i].value === k) { exists = true; break; } }
            if (!exists) {
                var opt = document.createElement('option');
                opt.value = k;
                opt.text = l(this._LOP_EXPORTS[k]);
                sel.appendChild(opt);
            }
        }
    },

    /**
     * Modelo neutro de un widget LOP para el exportador: { title, desc, days,
     * boxes:[{v,l,mod}], tables:[{title, headers, rows}], notes:[] }. A partir
     * de él _lopModelHtml arma el modal/PDF HTML y _lopPdfContent el pdfMake.
     * Los datos son los ya calculados por los widgets: el exportador no hace
     * requests. Sin datos devuelve un modelo con solo `notes`.
     */
    _lopExportModel: function (which) {
        var me = this;
        var nd = l('N/D');
        var f = function (n, d) { return me._lopFmt(n, d); };
        var m = { title: this._lopExportTitle(which), desc: '', days: 7, boxes: [], tables: [], notes: [] };

        if (which === 'lop_sucursales') {
            m.desc = l('Vehículos del alcance dentro de cada sucursal o base del cliente según su última posición. Disponible = estacionado y en línea; % estacionados sobre los vehículos presentes.');
            var b = this._lopBranchData;
            if (!b) { m.notes.push(l('Sin datos de sucursales cargados.')); return m; }
            m.boxes = [{ v: b.totals.inside, l: l('en sucursal'), mod: 'neutral' }, { v: b.totals.outside, l: l('fuera de sucursal'), mod: 'mid' }, { v: b.totals.scope, l: l('en el alcance'), mod: 'neutral' }];
            m.tables.push({ title: l('Sucursales'), headers: [l('Sucursal'), l('Presentes'), l('Disponibles'), l('En ruta'), l('Sin señal'), l('% estacionados')],
                rows: b.rows.map(function (r) { return [r.name, String(r.present), String(r.parked), String(r.moving), String(r.offline), r.pct + '%']; }) });
        } else if (which === 'lop_conduccion') {
            m.desc = l('Frenadas, aceleraciones y curvas bruscas y excesos de velocidad por vehículo, con índice de eventos cada 100 km. Fuentes: Fleet ECO report e infracciones de manejo.');
            m.days = ((this.config && this.config.ecoScore) || this.DEFAULT_CONFIG.ecoScore).windowDays || 8;
            var rows = this._lopDrivingRows();
            if (rows.length === 0) { m.notes.push(l('Sin datos de conducción cargados.')); return m; }
            var cfg = this._lopCfg('driving');
            var rk = this._lopRankDriving(rows, 'total', cfg.minKm);
            m.tables.push({ title: l('Vehículos por índice de eventos bruscos'), headers: [l('Vehículo'), l('Frenadas'), l('Aceleraciones'), l('Curvas'), l('Velocidad'), 'km', l('Eventos/100 km')],
                rows: rk.ranked.map(function (t) {
                    var r = t.row;
                    return [me.displayName(r.name), f(r.brake, 0), f(r.accel, 0), f(r.turn, 0), f(r.speed, 0), f(r.dist, 0), f(t.index, 1)];
                }) });
            var dr = this._lopDrivingDriverRows();
            if (dr && dr.length) {
                var rkd = this._lopRankDriving(dr, 'total', cfg.minKm);
                m.tables.push({ title: l('Conductores por índice de eventos bruscos'), headers: [l('Conductor'), l('Frenadas'), l('Aceleraciones'), l('Curvas'), l('Velocidad'), 'km', l('Eventos/100 km')],
                    rows: rkd.ranked.map(function (t) {
                        var r = t.row;
                        return [r.name, f(r.brake, 0), f(r.accel, 0), f(r.turn, 0), f(r.speed, 0), f(r.dist, 0), f(t.index, 1)];
                    }) });
            }
            m.notes.push(l('Índice calculado sobre vehículos con al menos') + ' ' + cfg.minKm + ' km. ' + l('N/D = la fuente no trae el dato; 0 puede indicar vehículo sin sensor.'));
        } else if (which === 'lop_combustible') {
            m.desc = l('Consumo por norma (reporte de combustible de PILOT) y L/100 km por vehículo; sobreconsumo frente a la mediana de su carpeta.');
            var d = this._lopFuel;
            if (!d) { m.notes.push(l('Sin datos de combustible cargados.')); return m; }
            m.days = d.days;
            var a = d.analysis, fc = this._lopCfg('fuel');
            m.boxes = [{ v: a.flagged, l: l('en sobreconsumo'), mod: a.flagged ? 'bad' : 'good' }, { v: f(a.fleetMedian, 1), l: l('mediana L/100 km'), mod: 'neutral' }, { v: f(a.p90, 1), l: l('percentil 90'), mod: 'neutral' }];
            var sorted = a.eligible.slice().sort(function (x, y) { return y.lPer100 - x.lPer100; });
            m.tables.push({ title: l('Vehículos por L/100 km'), headers: [l('Vehículo'), l('Litros'), 'km', 'L/100 km', l('vs mediana'), l('Estado')],
                rows: sorted.map(function (e) {
                    return [me.displayName(e.name), f(e.liters, 0), f(e.km, 0), f(e.lPer100, 1),
                        e.ratio === null ? nd : Math.round((e.ratio - 1) * 100) + '%', e.over ? l('Sobreconsumo') : 'OK'];
                }) });
            m.notes.push(l('Cobertura') + ': ' + a.eligible.length + ' ' + l('de') + ' ' + d.plan.queried + ' ' + l('vehículos consultados') +
                '; ' + a.noNorm + ' ' + l('sin norma de consumo (N/D)') + ', ' + a.lowKm + ' ' + l('con menos de') + ' ' + fc.minKm + ' km. ' +
                l('Sobreconsumo') + ' = +' + fc.overconsumptionPct + '% ' + l('sobre la mediana.'));
        } else if (which === 'lop_mantencion') {
            m.desc = l('Vehículos ordenados por odómetro frente al intervalo de servicio y al umbral de revisión configurados.');
            var mt = this._lopMaint;
            if (!mt) { m.notes.push(l('Sin datos de kilometraje cargados.')); return m; }
            var ma = mt.analysis;
            var lbl = { high: l('Revisión'), due: l('Servicio próximo'), ok: 'OK' };
            m.boxes = [{ v: ma.high, l: l('sugieren revisión'), mod: ma.high ? 'bad' : 'good' }, { v: ma.due, l: l('servicio próximo'), mod: ma.due ? 'mid' : 'good' }, { v: ma.noData, l: l('sin odómetro (N/D)'), mod: 'neutral' }];
            m.tables.push({ title: l('Odómetro'), headers: [l('Vehículo'), l('Odómetro'), l('Próx. servicio en'), l('Estado')],
                rows: ma.rows.map(function (r) { return [me.displayName(r.name), f(r.odo, 0) + ' km', f(r.toNext, 0) + ' km', lbl[r.status]]; }) });
            m.notes.push(l('Cobertura') + ': ' + ma.rows.length + ' ' + l('de') + ' ' + mt.total + ' ' + l('con odómetro') + '.');
        } else if (which === 'lop_tag') {
            m.desc = l('Pasadas por pórticos de peaje por vehículo (reporte Toll Roads de PILOT).');
            var t = this._lopTag;
            if (!t) { m.notes.push(l('Sin datos de peajes cargados o reporte no disponible en esta cuenta.')); return m; }
            m.days = t.days;
            var head = [l('Vehículo'), l('Pasadas')];
            if (t.hasAmount) { head.push(l('Monto')); }
            m.tables.push({ title: l('Vehículos con más pasadas'), headers: head,
                rows: t.rows.map(function (r) {
                    var row = [me.displayName(r.name), String(r.passes)];
                    if (t.hasAmount) { row.push(f(r.amount, 0)); }
                    return row;
                }) });
            m.notes.push(l('Consultados') + ' ' + t.queried + ' ' + l('vehículos con movimiento reciente.'));
        }
        return m;
    },

    _lopModelHtml: function (m, maxRows) {
        var esc = Ext.String.htmlEncode;
        var html = '';
        if (m.boxes.length) {
            html += '<div class="grid">' + m.boxes.map(function (b) {
                return '<div class="box ' + b.mod + '"><div class="v">' + esc(String(b.v)) + '</div><div class="l">' + esc(b.l) + '</div></div>';
            }).join('') + '</div>';
        }
        m.tables.forEach(function (t) {
            var rows = maxRows ? t.rows.slice(0, maxRows) : t.rows;
            html += (m.tables.length > 1 ? '<h2>' + esc(t.title) + '</h2>' : '') +
                '<table><tr>' + t.headers.map(function (h) { return '<th>' + esc(h) + '</th>'; }).join('') + '</tr>' +
                rows.map(function (r) {
                    return '<tr>' + r.map(function (c, i) { return '<td' + (i > 0 ? ' class="n"' : '') + '>' + esc(String(c)) + '</td>'; }).join('') + '</tr>';
                }).join('') + '</table>';
        });
        m.notes.forEach(function (n) { html += '<p class="sub">' + esc(n) + '</p>'; });
        return html;
    },

    _lopPdfContent: function (m, C, maxRows) {
        var me = this;
        if (m.boxes.length) {
            var colors = { good: '#238a4c', mid: '#a34d00', bad: '#ad1100', neutral: '#0a67a0' };
            C.push(this._pdfBoxes(m.boxes.map(function (b) { return { v: b.v, l: b.l, color: colors[b.mod] || colors.neutral }; })));
        }
        m.tables.forEach(function (t) {
            if (m.tables.length > 1) { C.push({ text: t.title, style: 'h2' }); }
            var rows = maxRows ? t.rows.slice(0, maxRows) : t.rows;
            C.push(me._pdfTable(t.headers, rows.map(function (r) {
                return r.map(function (c, i) { return i > 0 ? { text: String(c), alignment: 'right' } : String(c); });
            })));
        });
        m.notes.forEach(function (n) { C.push({ text: n, style: 'sub' }); });
    },

    /** Secciones LOP del Golden Report (HTML): solo los widgets con datos cargados. */
    _lopGoldenHtml: function () {
        var out = '';
        var esc = Ext.String.htmlEncode;
        for (var k in this._LOP_EXPORTS) {
            if (!this._LOP_EXPORTS.hasOwnProperty(k)) { continue; }
            try {
                var m = this._lopExportModel(k);
                if (m.tables.length === 0) { continue; }
                out += '<h2>' + esc(m.title) + '</h2>' + this._lopModelHtml(m, 10);
            } catch (err) {
                // Un widget LOP con datos raros no debe romper el Golden Report completo.
                this.widgetErrorCode('LOP-GOLDEN', err, k);
            }
        }
        return out;
    },

    _lopGoldenPdf: function (C) {
        for (var k in this._LOP_EXPORTS) {
            if (!this._LOP_EXPORTS.hasOwnProperty(k)) { continue; }
            try {
                var m = this._lopExportModel(k);
                if (m.tables.length === 0) { continue; }
                C.push({ text: m.title, style: 'h2' });
                this._lopPdfContent(m, C, 10);
            } catch (err) {
                this.widgetErrorCode('LOP-GOLDEN', err, k);
            }
        }
    },

    updateGpsSignalCard: function (b24, b48, bMore, bNoData) {
        // 3 buckets en fila horizontal, sin footer. El chip "Más de 48h" es
        // el único que pulsa. El click abre el modal de detalle
        // (buildGpsSignalReport vía bindAlertReportLinks); data-gps-bucket es
        // la clave que usa ese handler.
        var chip = function (mod, label, count, title, bucket, hideBadge) {
            var cn = [{ tag: 'span', cls: 'promatic_dashboard_enhancer-signal-chip__label', html: label }];
            if (!hideBadge) {
                cn.push({ tag: 'span', cls: 'promatic_dashboard_enhancer-signal-chip__badge', html: String(count) });
            }
            return {
                cls: 'promatic_dashboard_enhancer-signal-chip promatic_dashboard_enhancer-signal-chip--' + mod +
                    (bucket ? ' promatic_dashboard_enhancer-signal-chip--clickable' : ''),
                title: title,
                'data-gps-bucket': bucket || undefined,
                cn: cn
            };
        };

        // Watermark sutil de fondo detrás de los chips. currentColor hereda
        // el gris de la card y no compite con los chips de color.
        var svgNoGps =
            '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">' +
            '<g fill="none" stroke="currentColor" stroke-width="2.5">' +
            '<path stroke-linecap="round" d="m22 8l-3-3m0 0l-3-3m3 3l-3 3m3-3l3-3"/>' +
            '<path d="M9 10.03A3.515 3.515 0 0 1 13.97 15"/>' +
            '<path stroke-linejoin="round" d="M4.853 19.147c3.196 3.196 8.06 3.707 11.789 1.533c.886-.517 1.33-.776 1.357-1.302s-.471-.89-1.468-1.618c-1.848-1.35-3.667-3-5.48-4.812C9.24 11.136 7.59 9.317 6.24 7.47c-.728-.997-1.092-1.495-1.618-1.468s-.785.47-1.302 1.357c-2.174 3.73-1.663 8.593 1.533 11.79Z"/>' +
            '</g></svg>';

        // Sin ningún vehículo desconectado en los buckets: un único chip
        // verde "Todo OK" reemplaza al set de chips (con el rojo pulsando).
        // Evita la falsa alarma visual en flotas chicas donde ">48h" nunca
        // tiene datos.
        var track = (b24 === 0 && b48 === 0 && bMore === 0 && bNoData === 0)
            ? { cn: [chip('ok', l('Todo OK — sin desconexiones'), 0, l('Ningún vehículo desconectado actualmente'), null, true)] }
            : {
                cn: [
                    chip('yellow', l('Menos de 24h'), b24, l('Vehículos desconectados hace menos de 24h — click para ver detalle'), '24'),
                    chip('orange', l('Entre 24 y 48h'), b48, l('Vehículos desconectados entre 24 y 48h — click para ver detalle'), '48'),
                    chip('red', l('Más de 48h'), bMore, l('Vehículos desconectados hace más de 48h — click para ver detalle'), 'more'),
                    chip('gray', l('Sin dato'), bNoData, l('Sin dato de última conexión — click para ver detalle'), 'nodata')
                ]
            };
        track.cls = 'promatic_dashboard_enhancer-signal-track';

        this.updateCardBody('gps_signal', Ext.DomHelper.markup({
            cls: 'promatic_dashboard_enhancer-signal-body',
            cn: [
                { cls: 'promatic_dashboard_enhancer-signal-watermark', html: svgNoGps },
                track
            ]
        }));
    },

    updateFlotaLopCard: function (total, moving, parked, offlineCount) {
        var pct = function (n) {
            return total > 0 ? Math.round((n / total) * 100) : 0;
        };
        var activos = total - offlineCount;

        this.updateCardBody('flota', Ext.DomHelper.markup({
            cls: 'promatic_dashboard_enhancer-fleet-quadrants',
            cn: [
                { cls: 'promatic_dashboard_enhancer-fleet-quadrant', cn: [
                    { tag: 'div', cls: 'promatic_dashboard_enhancer-fleet-quadrant__pct', html: pct(activos) + '%' },
                    { tag: 'div', cls: 'promatic_dashboard_enhancer-fleet-quadrant__lbl', html: l('Activos') }
                ] },
                { cls: 'promatic_dashboard_enhancer-fleet-quadrant promatic_dashboard_enhancer-fleet-quadrant--moving', cn: [
                    { tag: 'div', cls: 'promatic_dashboard_enhancer-fleet-quadrant__pct', html: pct(moving) + '%' },
                    { tag: 'div', cls: 'promatic_dashboard_enhancer-fleet-quadrant__lbl', html: l('En movimiento') }
                ] },
                { cls: 'promatic_dashboard_enhancer-fleet-quadrant promatic_dashboard_enhancer-fleet-quadrant--parked', cn: [
                    { tag: 'div', cls: 'promatic_dashboard_enhancer-fleet-quadrant__pct', html: pct(parked) + '%' },
                    { tag: 'div', cls: 'promatic_dashboard_enhancer-fleet-quadrant__lbl', html: l('Estacionado') }
                ] },
                { cls: 'promatic_dashboard_enhancer-fleet-quadrant promatic_dashboard_enhancer-fleet-quadrant--offline', cn: [
                    { tag: 'div', cls: 'promatic_dashboard_enhancer-fleet-quadrant__pct', html: pct(offlineCount) + '%' },
                    { tag: 'div', cls: 'promatic_dashboard_enhancer-fleet-quadrant__lbl', html: l('Sin conexión') }
                ] }
            ]
        }), 0, true);
    },

    updateSummary: function (total, online) {
        if (!this.summaryBar) {
            return;
        }

        var pct = total > 0 ? Math.round((online / total) * 100) : 0;

        this.summaryBar.update(Ext.DomHelper.markup({
            cls: 'promatic_dashboard_enhancer-summary__row',
            cn: [
                { cls: 'promatic_dashboard_enhancer-stat', cn: [
                    { tag: 'span', cls: 'promatic_dashboard_enhancer-stat__value', html: String(total) },
                    { tag: 'span', cls: 'promatic_dashboard_enhancer-stat__label', html: l('flota') }
                ] },
                { cls: 'promatic_dashboard_enhancer-stat', cn: [
                    { tag: 'span', cls: 'promatic_dashboard_enhancer-dot promatic_dashboard_enhancer-dot-online' },
                    { tag: 'span', cls: 'promatic_dashboard_enhancer-stat__value', html: String(online) },
                    { tag: 'span', cls: 'promatic_dashboard_enhancer-stat__label', html: l('en línea') + ' (' + pct + '%)' }
                ] },
                { cls: 'promatic_dashboard_enhancer-stat', cn: [
                    { tag: 'span', cls: 'promatic_dashboard_enhancer-dot promatic_dashboard_enhancer-dot-offline' },
                    { tag: 'span', cls: 'promatic_dashboard_enhancer-stat__value', html: String(total - online) },
                    { tag: 'span', cls: 'promatic_dashboard_enhancer-stat__label', html: l('desconectados') }
                ] },
                { cls: 'promatic_dashboard_enhancer-summary__updated', html: l('actualizado') + ' ' + Ext.Date.format(this._lastManualRefresh || new Date(), 'H:i:s') }
            ]
        }));
    },

    /**
     * Fetch compartido de reports.php (get_report / report_type) y
     * analytics/*. Todo va con fetch() nativo, nunca Ext.Ajax.request: dentro
     * del proxy /store/<extension>/ de una extensión, Ext.Ajax reescribe las
     * rutas relativas y devuelve 404.
     */
    buildReportBody: function (reportType, vehIdsCsv, startDate, stopDate) {
        var pad = function (n) {
            return n < 10 ? '0' + n : '' + n;
        };
        var fmtDate = function (d) {
            return pad(d.getDate()) + '.' + pad(d.getMonth() + 1) + '.' + d.getFullYear();
        };
        var fmtMonth = function (d) {
            return pad(d.getMonth() + 1) + '.' + d.getFullYear();
        };

        var pairs = [
            ['download', '0'], ['start_time', '00:00'], ['stop_time', '00:00'],
            ['veh_id', vehIdsCsv],
            ['zones_id', ''], ['lines_id', ''], ['stopping_points_id', ''],
            ['drivers_id', ''], ['groups_id', ''], ['holidays', ''],
            ['lang', 'es'], ['explode', '1'],
            ['start_month', fmtMonth(startDate)], ['stop_month', fmtMonth(stopDate)],
            ['pre_start_date', fmtDate(startDate)], ['pre_stop_date', fmtDate(stopDate)],
            ['start_date', fmtDate(startDate) + ' 00:00'], ['stop_date', fmtDate(stopDate) + ' 00:00'],
            ['group', '1'], ['tags[]', ''], ['level[]', ''],
            ['event_group', ''], ['event_groups[]', ''],
            ['map_type', '1'], ['trailer', ''], ['last_ibutton_used', '0'],
            ['report_type', String(reportType)],
            ['vehicle_not_moving_time', '1'], ['vehicles_has_covered_km', '1'],
            ['fillings', 'on'], ['stales', 'on'], ['speed', 'on'], ['rashod', 'on'],
            ['stops', 'on'], ['run', 'on'], ['planned_stops', 'on'], ['unplanned_stops', 'on'],
            ['inside_bus_line', 'on'], ['outside_bus_line', 'on'],
            ['emp_name', ''], ['reason_for_opening', ''], ['report_mc_aid', ''],
            ['trip_types[]', '1'], ['trip_types[]', '2'],
            ['contr_time', '120'], ['limit_count', '0'], ['contr_time_max', '0'],
            ['inspections_report_type', '0'], ['set_months_range', '1'],
            ['type', '1'], ['template', '1']
        ];

        var parts = [];
        for (var i = 0; i < pairs.length; i++) {
            parts.push(encodeURIComponent(pairs[i][0]) + '=' + encodeURIComponent(pairs[i][1]));
        }
        return parts.join('&');
    },

    fetchReportType: function (reportType, vehIdsCsv, startDate, stopDate, timeoutMs) {
        var body = this.buildReportBody(reportType, vehIdsCsv, startDate, stopDate);
        var ctrl = new AbortController();
        var timeout = setTimeout(function () {
            ctrl.abort();
        }, timeoutMs || 20000);

        return fetch('/backend/ax/reports.php', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: body,
            signal: ctrl.signal
        }).then(function (resp) {
            if (!resp.ok) {
                throw new Error('HTTP ' + resp.status);
            }
            return resp.json();
        }).finally(function () {
            clearTimeout(timeout);
        });
    },

    /**
     * API v3 /api/v3/vehicles/trips: 1 request por vehículo. La URL es
     * RELATIVA al host (same-origin); un host absoluto se bloquea por CORS.
     * Devuelve { code, msg, data: [tramos] }; cada tramo trae gps (km por
     * GPS) y can (km por odómetro CAN, a veces 0). data:[] si el vehículo no
     * se movió.
     */
    fetchVehicleTripsV3: function (agentId, tsUnixSec, teUnixSec, timeoutMs) {
        var url = '/api/v3/vehicles/trips?agent_id=' + encodeURIComponent(agentId) +
            '&ts=' + encodeURIComponent(tsUnixSec) + '&te=' + encodeURIComponent(teUnixSec);
        var ctrl = new AbortController();
        var timeout = setTimeout(function () {
            ctrl.abort();
        }, timeoutMs || 8000);

        return fetch(url, {
            method: 'GET',
            credentials: 'include',
            signal: ctrl.signal
        }).then(function (resp) {
            if (!resp.ok) {
                throw new Error('HTTP ' + resp.status);
            }
            return resp.json();
        }).finally(function () {
            clearTimeout(timeout);
        });
    },

    /**
     * Suma el km de todos los tramos de una respuesta de fetchVehicleTripsV3.
     * kmField: 'gps' (default) | 'can'. data ausente o [] → 0.
     */
    sumTripsKm: function (tripsResponse, kmField) {
        var field = kmField || 'gps';
        var tramos = (tripsResponse && tripsResponse.data) || [];
        var km = 0;
        for (var i = 0; i < tramos.length; i++) {
            km += Number(tramos[i][field]) || 0;
        }
        return Math.round(km * 10) / 10;
    },

    /**
     * startIso/stopIso opcionales (formato "YYYY-MM-DDTHH:MM:SS"). Sin ellos:
     * día actual con today=true. Con ellos: ventana real con today='',
     * necesario para el Top KM (ventana de N días).
     */
    fetchAnalyticsMainData: function (vehIdsCsv, timeoutMs, startIso, stopIso) {
        var isoDay = new Date().toISOString().slice(0, 10) + 'T00:00:00';
        var hasRange = !!(startIso && stopIso);
        var pairs = [
            ['cmd', 'get_main_data'], ['cons_value', 'l/100km'],
            ['ts', hasRange ? startIso : isoDay],
            ['te', hasRange ? stopIso : isoDay],
            ['today', hasRange ? '' : 'true'], ['sync', ''],
            ['agent_ids', vehIdsCsv]
        ];
        var parts = [];
        for (var i = 0; i < pairs.length; i++) {
            parts.push(encodeURIComponent(pairs[i][0]) + '=' + encodeURIComponent(pairs[i][1]));
        }

        var ctrl = new AbortController();
        var timeout = setTimeout(function () {
            ctrl.abort();
        }, timeoutMs || 8000);

        return fetch('/backend/ax/analytics/vehicles.php', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: parts.join('&'),
            signal: ctrl.signal
        }).then(function (resp) {
            if (!resp.ok) {
                throw new Error('HTTP ' + resp.status);
            }
            return resp.json();
        }).finally(function () {
            clearTimeout(timeout);
        });
    },

    fetchDashboardCmd: function (cmd, vehIdsCsv, timeoutMs) {
        var isoDay = new Date().toISOString().slice(0, 10) + 'T00:00:00';
        var pairs = [['cmd', cmd], ['agent_ids', vehIdsCsv], ['ts', isoDay], ['te', isoDay]];
        var parts = [];
        for (var i = 0; i < pairs.length; i++) {
            parts.push(encodeURIComponent(pairs[i][0]) + '=' + encodeURIComponent(pairs[i][1]));
        }

        var ctrl = new AbortController();
        var timeout = setTimeout(function () {
            ctrl.abort();
        }, timeoutMs || 8000);

        return fetch('/backend/ax/analytics/dashboard.php', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: parts.join('&'),
            signal: ctrl.signal
        }).then(function (resp) {
            if (!resp.ok) {
                throw new Error('HTTP ' + resp.status);
            }
            return resp.json();
        }).finally(function () {
            clearTimeout(timeout);
        });
    },

    fetchEventCount: function (vehIdsCsv, type, dateStart, dateStop) {
        var qs = 'cmd=search&veh=' + encodeURIComponent(vehIdsCsv) +
            '&type=' + encodeURIComponent(type) +
            '&date_start=' + encodeURIComponent(dateStart) +
            '&date_stop=' + encodeURIComponent(dateStop) +
            '&limit=1&page=1&start=0';

        return fetch('/backend/ax/mod/events.php?' + qs, { credentials: 'include' })
            .then(function (resp) {
                if (!resp.ok) {
                    throw new Error('HTTP ' + resp.status);
                }
                return resp.json();
            })
            .then(function (data) {
                return (data && typeof data.total === 'number') ? data.total : 0;
            });
    },

    /**
     * Espera (polling acotado, 40 x 500 ms = 20 s) a que online_tree tenga
     * vehículos y devuelve la lista de agent_ids; patrón compartido por todos
     * los widgets que dependen de la flota. Es polling y NO una re-
     * suscripción a 'datachanged': el árbol Online se actualiza seguido y re-
     * suscribir en cada disparo se volvía un loop caliente.
     */
    withFleetVehicleIds: function (callback, attempt) {
        var me = this;
        attempt = attempt || 0;
        var onlineTree = this.getOnlineTree();
        var vehIds = onlineTree ? this.getFleetVehicleIds(onlineTree) : [];

        if (vehIds.length > 0) {
            var fleetCfg = (this.config && this.config.fleet) || this.DEFAULT_CONFIG.fleet;
            var maxVeh = fleetCfg.maxVehicles || 500;
            if (vehIds.length > maxVeh) {
                console.warn('[promatic_dashboard_enhancer] withFleetVehicleIds: ' + vehIds.length +
                    ' vehículos en alcance, cortando al tope de ' + maxVeh +
                    ' (fleet.maxVehicles). Marca menos vehículos en el panel "Principal" para acotar.');
                vehIds = vehIds.slice(0, maxVeh);
            }
            callback.call(this, vehIds);
            return;
        }

        if (attempt < 40) {
            // Si se sigue la selección de PILOT y hay carpetas marcadas pero
            // colapsadas, se intenta expandirlas en cada reintento (barato,
            // con guard interno): si el usuario marca la carpeta mientras el
            // waiter gira, se abre sola.
            if (onlineTree && this.effectiveFleetScope() === 'pilot-selection') {
                this._selectionExpandRetry = false;
                this.expandCheckedFolders(onlineTree);
            }
            Ext.defer(function () { me.withFleetVehicleIds(callback, attempt + 1); }, 500, this);
            return;
        }

        var msg;
        if (this.effectiveFleetScope() === 'pilot-selection') {
            msg = 'Alcance "selección de PILOT": no hay vehículos marcados en el panel "Principal" ' +
                '(o solo carpetas colapsadas, cuyos hijos PILOT no materializa hasta expandir). ' +
                'Marca vehículos o mueve el slider a "Toda la flota".';
        } else {
            msg = 'Alcance "toda la flota" — el árbol Online no cargó vehículos.';
        }
        console.warn('[promatic_dashboard_enhancer] withFleetVehicleIds: 0 vehículos tras 20s. ' + msg);
    },

    /**
     * Card "Top 5 · Vehículos con más KM".
     *
     * Fuente primaria: analytics/vehicles.php cmd=get_main_data →
     * ratings.data (km por vehículo en UNA llamada, sin reports.php ni riesgo
     * de timeout). Fallback automático: reports.php report_type=4.
     *
     * En ambos casos se pre-filtra a los vehículos con movimiento reciente
     * (top5km.windowDays) y se corta a un tope (top5km.activeVehicleCap) para
     * no disparar el job asíncrono + WebSocket de analytics/vehicles.php en
     * flotas grandes. Un vehículo sin movimiento tiene 0 km, así que el
     * filtro no cambia el ranking.
     */
    loadTop5KmData: function () {
        var me = this;
        var cfg = (me.config && me.config.top5km) || me.DEFAULT_CONFIG.top5km;
        var days = cfg.windowDays || 7;
        var cap = cfg.activeVehicleCap || 300;
        var count = cfg.count || 5;

        // Nonce para invalidar respuestas en vuelo: si el usuario amplía la
        // selección y se vuelve a disparar loadTop5KmData antes de que
        // resuelva la consulta anterior, la vieja no debe pisar el render
        // nuevo.
        var loadNonce = (me._top5LoadNonce = (me._top5LoadNonce || 0) + 1);

        this.withFleetVehicleIds(function () {
            var onlineTree = me.getOnlineTree();
            var scopeIds = me.getFleetVehicleIds(onlineTree);
            var scopeTotal = scopeIds.length;
            var vehIds = me.getRecentlyActiveIds(onlineTree, days);
            var usedScopeFallback = false;

            // Al ampliar la selección con vehículos sin movimiento en la
            // ventana (recién agregados a la cuenta, o sin last_move fresco
            // en el store), el filtro "recientemente activo" los deja fuera y
            // el ranking parece no cambiar. Si el filtro no dejó a nadie pero
            // hay vehículos en el alcance, se consulta el alcance completo
            // (trips-v3 dirá quién tiene km reales); el cap protege el
            // volumen.
            if (vehIds.length === 0 && scopeTotal > 0 &&
                !me._selectionExpanding && !me._selectionCollapsed && !me._selectionEmpty) {
                vehIds = scopeIds.slice();
                usedScopeFallback = true;
            }

            var capped = false;
            if (vehIds.length > cap) {
                vehIds = vehIds.slice(0, cap);
                capped = true;
            }

            Store.promatic_dashboard_enhancer.Module.debugLog('Top KM: ' + vehIds.length +
                (usedScopeFallback ? ' vehículos del alcance (sin filtro de actividad)'
                    : ' vehículos con movimiento en ' + days + 'd') +
                ' (de ' + scopeTotal + ' en alcance)' +
                (capped ? ' [cortado al tope de ' + cap + ']' : '') + ' — top ' + count);

            if (vehIds.length === 0) {
                var msg = l('Ningún vehículo con recorrido reciente.');
                if (me._selectionExpanding || me._selectionCollapsed) {
                    msg = l('Cargando vehículos de las carpetas seleccionadas…');
                    // La expansión de carpetas es async y 'checkchange' puede
                    // no llegar si ya estaban parcialmente materializadas: se
                    // reintenta una vez cuando el store terminó de poblarse.
                    if (loadNonce === me._top5LoadNonce) {
                        Ext.defer(function () {
                            if (loadNonce === me._top5LoadNonce) { me.loadTop5KmData(); }
                        }, 1500, me);
                    }
                } else if (me._selectionEmpty) {
                    msg = l('Selecciona vehículos en el panel "Principal" para ver el ranking.');
                }
                me.updateCardBody('top5km', msg);
                return;
            }

            var nameToId = {};
            var records = me.getScopedFleetRecords(onlineTree);
            for (var r = 0; r < records.length; r++) {
                var nm = records[r].get('name');
                if (nm) { nameToId[nm] = records[r].get('agentid'); }
            }

            var stopDate = new Date();
            var startDate = new Date();
            startDate.setDate(startDate.getDate() - days);
            startDate.setHours(0, 0, 0, 0);

            var csv = vehIds.join(',');

            // Descarta el render si ya arrancó una carga más nueva (ver
            // loadNonce).
            var stale = function () { return loadNonce !== me._top5LoadNonce; };

            var runReports = function () {
                return me.fetchReportType(4, csv, startDate, stopDate, 20000)
                    .then(function (report) {
                        if (stale()) { return; }
                        me.renderTop5Km(me.parseReportType4(report, nameToId), days, startDate, stopDate, count);
                        Store.promatic_dashboard_enhancer.Module.debugLog('Top KM servido por: reports');
                    });
            };
            var runRatings = function () {
                return me.fetchAnalyticsMainData(csv, 15000,
                    startDate.toISOString().slice(0, 19), stopDate.toISOString().slice(0, 19))
                    .then(function (mainData) {
                        if (stale()) { return; }
                        me.renderTop5Km(me.parseRatingsTop5(mainData), days, startDate, stopDate, count);
                        Store.promatic_dashboard_enhancer.Module.debugLog('Top KM servido por: ratings');
                    });
            };
            var runTripsV3 = function () {
                var tripIds = vehIds.slice(0, cfg.tripsMaxVehicles || 100);
                return me._top5FromTripsV3(tripIds, startDate, stopDate, nameToId, cfg)
                    .then(function (ranked) {
                        if (stale()) { return; }
                        var withKm = ranked.filter(function (x) { return x.km > 0; });
                        if (withKm.length === 0) {
                            throw new Error('trips-v3 sin km > 0');
                        }
                        me.renderTop5Km(withKm, days, startDate, stopDate, count);
                        Store.promatic_dashboard_enhancer.Module.debugLog('Top KM servido por: trips-v3 (' +
                            tripIds.length + ' vehículos consultados)');
                    });
            };

            var fail = function (err) { me.reportTop5Error(err, vehIds.length, days); };

            if (cfg.source === 'reports') {
                runReports().catch(fail);
            } else if (cfg.source === 'ratings') {
                runRatings().catch(function (err) {
                    console.warn('[promatic_dashboard_enhancer] Top KM: ratings falló (' +
                        (err && err.message ? err.message : err) + ') — fallback a reports');
                    runReports().catch(fail);
                });
            } else {
                // 'trips-v3' (default)
                runTripsV3().catch(function (err) {
                    console.warn('[promatic_dashboard_enhancer] Top KM: trips-v3 falló (' +
                        (err && err.message ? err.message : err) + ') — fallback a reports');
                    runReports().catch(fail);
                });
            }
        });
    },

    /**
     * Rama "trips-v3" del Top KM: consulta /api/v3/vehicles/trips por cada
     * vehículo candidato, en lotes concurrentes de cfg.tripsBatchSize (los
     * lotes van en serie). Un vehículo que falla cuenta 0 km sin abortar el
     * batch.
     *
     * CIRCUIT BREAKER: se corta toda la cola si se acumulan
     * CONSECUTIVE_FAIL_LIMIT fallos seguidos. Sin él, una ráfaga larga de 401
     * seguidos (vehículos que la API v3 rechaza) hacía que PILOT cortara la
     * sesión del usuario por abuso. El breaker corta apenas queda claro que
     * la API rechaza en cadena; el llamador hace fallback a reports.php si el
     * resultado queda sin km > 0.
     *
     * Devuelve ranked = [{name, km, id}] ordenado desc; id = agentid, name =
     * nombre del árbol si se conoce, si no el agent_id como string.
     */
    _top5FromTripsV3: function (vehIds, startDate, stopDate, nameToId, cfg) {
        var me = this;
        var batchSize = cfg.tripsBatchSize || 4;
        var kmField = cfg.kmField || 'gps';
        var CONSECUTIVE_FAIL_LIMIT = 8;
        var tsUnix = Math.floor(startDate.getTime() / 1000);
        var teUnix = Math.floor(stopDate.getTime() / 1000);
        var idToName = {};
        for (var nm in nameToId) {
            if (nameToId.hasOwnProperty(nm)) { idToName[Number(nameToId[nm])] = nm; }
        }

        var results = [];
        var queue = vehIds.slice();
        var consecutiveFails = 0;
        var breakerTripped = false;
        var PromiseImpl = (typeof Ext !== 'undefined' && Ext.Promise) ? Ext.Promise : Promise;

        function runBatch() {
            if (queue.length === 0 || breakerTripped) { return PromiseImpl.resolve(); }
            var slice = queue.splice(0, batchSize);
            var calls = slice.map(function (id) {
                return me.fetchVehicleTripsV3(id, tsUnix, teUnix, 8000)
                    .then(function (resp) {
                        consecutiveFails = 0;
                        results.push({ id: id, km: me.sumTripsKm(resp, kmField) });
                    })
                    .catch(function (err) {
                        consecutiveFails++;
                        console.warn('[promatic_dashboard_enhancer] Top KM trips-v3: vehículo ' +
                            id + ' falló (' + (err && err.message ? err.message : err) + ') — cuenta 0');
                        results.push({ id: id, km: 0 });
                    });
            });
            return PromiseImpl.all(calls).then(function () {
                if (consecutiveFails >= CONSECUTIVE_FAIL_LIMIT) {
                    breakerTripped = true;
                    console.warn('[promatic_dashboard_enhancer] Top KM trips-v3: ' + consecutiveFails +
                        ' fallos consecutivos — se corta la cola (' + queue.length +
                        ' vehículos sin consultar) para no arriesgar la sesión con PILOT.');
                    return;
                }
                return runBatch();
            });
        }

        return runBatch().then(function () {
            var ranked = results.map(function (r) {
                return {
                    name: idToName[Number(r.id)] || String(r.id),
                    km: r.km,
                    id: r.id
                };
            });
            ranked.sort(function (a, b) { return b.km - a.km; });
            return ranked;
        });
    },

    reportTop5Error: function (err, vehCount, days) {
        var code = this.widgetErrorCode('TOP5KM', err, vehCount + ' vehículos, rango ' + days + ' días');
        this.updateCardBody('top5km', (code.indexOf('TIMEOUT') !== -1 ?
            l('El ranking de kilometraje está tardando demasiado.') :
            l('No se pudo cargar el ranking de kilometraje.')) + ' (' + code + ')');
    },

    /**
     * Parsea ratings.data de analytics/vehicles.php: keys[i] = [agent_id,
     * "placa - conductor - serie", modelo]; veh_driving_dist[i] = km del
     * vehículo i, alineado 1:1 con keys (ver spec/api.md). Lanza si el shape
     * no está, está desalineado o no hay ningún km > 0: eso dispara el
     * fallback a reports.php (ej. cuentas con ratings deshabilitado).
     *
     * Devuelve el ranking COMPLETO ordenado desc: renderTop5Km corta a
     * `count` para mostrar, y el link "ver todos" del pie usa la lista
     * entera.
     */
    parseRatingsTop5: function (mainData) {
        var rd = mainData && mainData.ratings && mainData.ratings.data;
        var keys = rd && rd.keys;
        var dist = rd && rd.veh_driving_dist;
        if (!keys || !dist || !keys.length || keys.length !== dist.length) {
            throw new Error('ratings.data ausente o desalineado');
        }
        var ranked = [];
        for (var i = 0; i < keys.length; i++) {
            var km = Number(dist[i]) || 0;
            if (km <= 0) { continue; }
            var label = (keys[i] && keys[i][1]) || String(keys[i] && keys[i][0]) || '—';
            ranked.push({ name: label, km: km, id: keys[i] && keys[i][0] });
        }
        if (ranked.length === 0) {
            throw new Error('ratings.data sin km > 0');
        }
        ranked.sort(function (a, b) { return b.km - a.km; });
        return ranked;
    },

    /**
     * reports.php report_type=4: report.data[fecha][vehículo] = array de
     * tramos, cada uno con .length = km del tramo; se suma por vehículo.
     * nameToId: mapa opcional nombre→agentid para el link a Informes.
     * Devuelve el ranking completo ordenado desc (ver parseRatingsTop5).
     */
    parseReportType4: function (report, nameToId) {
        nameToId = nameToId || {};
        var totalsByVehicle = {};
        var dateGroups = (report && report.data) || {};

        for (var dateKey in dateGroups) {
            if (!dateGroups.hasOwnProperty(dateKey)) {
                continue;
            }
            var vehGroups = dateGroups[dateKey];
            for (var vehKey in vehGroups) {
                if (!vehGroups.hasOwnProperty(vehKey)) {
                    continue;
                }
                var trips = vehGroups[vehKey];
                var sum = totalsByVehicle[vehKey] || 0;
                for (var i = 0; i < trips.length; i++) {
                    sum += trips[i].length || 0;
                }
                totalsByVehicle[vehKey] = sum;
            }
        }

        var ranked = [];
        for (var name in totalsByVehicle) {
            if (totalsByVehicle.hasOwnProperty(name)) {
                ranked.push({ name: name, km: totalsByVehicle[name], id: nameToId[name] });
            }
        }
        ranked.sort(function (a, b) { return b.km - a.km; });
        return ranked;
    },

    /**
     * ranked = [{ name, km, id? }] COMPLETO ordenado desc. days: ventana en
     * días; startDate/stopDate: rango real de la consulta; count: cuántas
     * filas muestra la card. El link "ver todos" del pie usa todo `ranked`.
     */
    renderTop5Km: function (ranked, days, startDate, stopDate, count) {
        ranked = ranked || [];
        days = days || 7;
        count = count || 5;
        stopDate = stopDate || new Date();
        if (!startDate) {
            startDate = new Date();
            startDate.setDate(startDate.getDate() - days);
        }

        this._lastTop5Ranked = ranked;

        if (ranked.length === 0) {
            this.updateCardBody('top5km', l('Sin datos de kilometraje para el período.'));
            return;
        }

        var top5 = ranked.slice(0, count);

        var startMs = startDate.getTime();
        var stopMs = stopDate.getTime();

        // Barra apilada: un segmento por vehículo, alto = % del total
        // mostrado. Los colores fijos g2/g1/g3/g4/g5 van en orden ascendente
        // de km; con más de 5 vehículos el ramp no alcanza y se cae a un tono
        // único (--g4) para no repetir colores.
        var segColors = ['var(--g2)', 'var(--g1)', 'var(--g3)', 'var(--g4)', 'var(--g5)'];
        var flatColor = top5.length > segColors.length;
        var total = 0;
        for (var s = 0; s < top5.length; s++) {
            total += top5[s].km;
        }
        var ascending = top5.slice().reverse();
        var segments = [];
        for (var a = 0; a < ascending.length; a++) {
            var segPct = total > 0 ? (ascending[a].km / total * 100) : 0;
            segments.push({
                cls: 'promatic_dashboard_enhancer-stacked-seg',
                style: 'height:' + segPct.toFixed(1) + '%;background:' +
                    (flatColor ? 'var(--g4)' : segColors[a % segColors.length]),
                title: Ext.String.htmlEncode(this.displayName(ascending[a].name)) + ' — ' + ascending[a].km.toFixed(0) + 'km'
            });
        }

        var maxKm = top5[0].km || 1;
        var rankRows = [];
        for (var j = 0; j < top5.length; j++) {
            var item = top5[j];
            var hasId = item.id !== undefined && item.id !== null && item.id !== '';
            var rowCls = 'promatic_dashboard_enhancer-rank-row' +
                (j === 0 ? ' promatic_dashboard_enhancer-rank-row--emphasized' : '') +
                (hasId ? '' : ' promatic_dashboard_enhancer-rank-row--nolink');
            var row = {
                tag: hasId ? 'a' : 'div', cls: rowCls,
                cn: [
                    { tag: 'span', cls: 'promatic_dashboard_enhancer-rank-name', html: Ext.String.htmlEncode(this.displayName(item.name)) },
                    { cls: 'promatic_dashboard_enhancer-rank-track', cn: [
                        { cls: 'promatic_dashboard_enhancer-rank-fill', style: 'width:' + (item.km / maxKm * 100).toFixed(0) + '%' }
                    ] },
                    { tag: 'span', cls: 'promatic_dashboard_enhancer-rank-val', html: item.km.toFixed(0) + 'km' },
                    { tag: 'span', cls: 'promatic_dashboard_enhancer-chev', html: '›' }
                ]
            };
            if (hasId) {
                row.href = '#';
                row.title = l('Ver informe de kilómetros de') + ' ' + Ext.String.htmlEncode(this.displayName(item.name));
                row['data-km-report'] = String(item.id);
                row['data-km-start'] = String(startMs);
                row['data-km-stop'] = String(stopMs);
            }
            rankRows.push(row);
        }

        var dateFmt = function (d) {
            var pad = function (n) { return n < 10 ? '0' + n : '' + n; };
            return pad(d.getDate()) + '-' + pad(d.getMonth() + 1) + '-' + d.getFullYear();
        };

        this.updateCardBody('top5km', Ext.DomHelper.markup({
            cls: 'promatic_dashboard_enhancer-km-widget-body',
            cn: [
                { cls: 'promatic_dashboard_enhancer-km-stack-wrap', cn: [
                    { cls: 'promatic_dashboard_enhancer-stacked-track promatic_dashboard_enhancer-stacked-track--v', cn: segments },
                    { cls: 'promatic_dashboard_enhancer-km-stack-total', cn: [
                        { tag: 'b', html: total.toFixed(0) },
                        { html: 'km &middot; ' + l('top') + ' ' + top5.length }
                    ] }
                ] },
                { cls: 'promatic_dashboard_enhancer-km-top5', cn: [
                    { cls: 'promatic_dashboard_enhancer-km-date-range', html: dateFmt(startDate) + ' — ' + dateFmt(stopDate) }
                ].concat(rankRows).concat([
                    { cls: 'promatic_dashboard_enhancer-km-color-legend', cn: [
                        { tag: 'span', cls: 'promatic_dashboard_enhancer-km-legend-grad' },
                        { html: l('Oscuro = más km · Claro = menos km') }
                    ] }
                ]) }
            ]
        }));

        // El link del pie lleva al informe de kilómetros de TODOS los
        // vehículos del ranking (no solo los `count` que muestra la card),
        // con el mismo rango. El pie se crea con la card, antes de tener
        // datos, y se completa acá.
        var allIds = [];
        for (var k = 0; k < ranked.length; k++) {
            var rid = ranked[k].id;
            if (rid !== undefined && rid !== null && rid !== '') { allIds.push(rid); }
        }
        var cardEl = Ext.get('promatic_dashboard_enhancer-card-top5km');
        var footA = cardEl && cardEl.down('.promatic_dashboard_enhancer-card__footer a');
        if (footA) {
            if (allIds.length) {
                footA.set({
                    'data-km-report': allIds.join(','),
                    'data-km-start': String(startMs),
                    'data-km-stop': String(stopMs)
                });
            } else {
                footA.dom.removeAttribute('data-km-report');
            }
        }
    },

    /**
     * Delegado de clicks para los links a Informes (filas del ranking + pie
     * de Top KM). Se bindea una vez sobre el elemento del panel.
     */
    bindKmReportLinks: function (panel) {
        var me = this;
        var el = panel && panel.getEl && panel.getEl();
        if (!el || el._kmReportBound) { return; }
        el._kmReportBound = true;
        el.on('click', function (e) {
            var a = e.getTarget('[data-km-report]', 10, true);
            if (!a) { return; }
            e.preventDefault();
            var raw = a.getAttribute('data-km-report');
            if (!raw) { return; }
            var ids = raw.split(',').map(Number).filter(function (n) { return !isNaN(n); });
            var start = new Date(Number(a.getAttribute('data-km-start')));
            var stop = new Date(Number(a.getAttribute('data-km-stop')));
            me.openKmReport(ids, start, stop);
        });
    },

    openKmReport: function (vehicleIds, startDate, stopDate) {
        if (!vehicleIds || !vehicleIds.length) { return; }
        var me = this;
        try {
            if (!this.activateReportsTab()) {
                console.warn('[promatic_dashboard_enhancer] openKmReport: no se pudo activar el tab de Informes');
                return;
            }
            Ext.defer(function () {
                try {
                    me.runNativeReport(4, vehicleIds, startDate, stopDate);
                } catch (e) {
                    console.warn('[promatic_dashboard_enhancer] runNativeReport falló:', e);
                }
            }, 200);
        } catch (err) {
            console.warn('[promatic_dashboard_enhancer] openKmReport falló:', err);
        }
    },

    /**
     * Activa el tab de Informes en la navegación de PILOT. El índice varía
     * por cuenta: se busca por identidad/título/xtype y se cae al 2 (el valor
     * del ejemplo oficial) si no se encuentra.
     */
    activateReportsTab: function () {
        var nav = window.skeleton && skeleton.navigation;
        if (!nav || typeof nav.setActiveTab !== 'function') { return false; }
        var tabs = (nav.items && nav.items.items) || [];
        var i;
        for (i = 0; i < tabs.length; i++) {
            if (nav.reports && tabs[i] === nav.reports) { nav.setActiveTab(i); return true; }
        }
        for (i = 0; i < tabs.length; i++) {
            var t = tabs[i];
            var xt = ((t.xtype || (t.getXType && t.getXType()) || '') + '').toLowerCase();
            var ti = ((t.title || (t.tabConfig && t.tabConfig.title) || '') + '').toLowerCase();
            if (xt.indexOf('report') !== -1 || ti.indexOf('report') !== -1 || ti.indexOf('informe') !== -1) {
                nav.setActiveTab(i);
                return true;
            }
        }
        nav.setActiveTab(2);
        return true;
    },

    /**
     * Dispara un reporte nativo desde código (función entregada por Pilot,
     * adaptada a método). Requiere que el panel de Informes ya esté activo
     * (ver activateReportsTab).
     */
    runNativeReport: function (reportType, vehicleIds, startDate, stopDate) {
        var me = this;
        var reports = window.skeleton && skeleton.navigation && skeleton.navigation.reports;
        if (!reports || !reports.down) {
            console.warn('[promatic_dashboard_enhancer] runNativeReport: panel de Informes no disponible');
            return;
        }
        var reportCombo = reports.down('#report_type');
        var objectsTree = reports.down('#reports_objects_tree');
        if (!reportCombo || !objectsTree) {
            console.warn('[promatic_dashboard_enhancer] runNativeReport: controles del panel de Informes no encontrados');
            return;
        }
        var reportStore = reportCombo.getStore();
        var objectsStore = objectsTree.getStore();
        var ids = vehicleIds.map(Number);

        function submitWhenReady() {
            var rec = reportStore.findRecord('id', Number(reportType), 0, false, false, true);
            if (!rec) {
                console.error('[promatic_dashboard_enhancer] runNativeReport: report type no encontrado:', reportType);
                // La cuenta puede no tener este informe habilitado: al menos
                // se deja marcado el vehículo para que el usuario elija.
                me.selectVehiclesInReports(ids);
                return;
            }
            reportCombo.setValue(rec.get('id'));
            reportCombo.setSelection(rec);
            reports.selectReport(reportCombo, rec);
            reports.down('#report_date1').setValue(startDate);
            reports.down('#report_date2').setValue(stopDate);
            // "Dividir" (explode_combo): se busca la opción "No dividir" en
            // el store por su etiqueta y se setea su valueField real, NO un
            // literal. El valueField ("abbr") y el valor de "No dividir"
            // varían por cuenta/idioma; un setValue(0) fijo deja el combo en
            // estado inválido → explode="" en el submit → el job del reporte
            // nunca termina ("El informe está siendo creado" colgado). Va
            // después de selectReport (que reconfigura el form). Defensivo:
            // el combo puede no existir en otra cuenta.
            var explodeCombo = reports.down('#explode_combo');
            if (explodeCombo && explodeCombo.getStore) {
                var explodeStore = explodeCombo.getStore();
                var noSplit = explodeStore && explodeStore.findRecord(
                    'name', /no dividir|don't split|do not split|не разбивать/i, 0, false, false, false);
                // Fallback: "No dividir" es la última opción del store (abbr
                // más alto) en todas las cuentas vistas.
                if (!noSplit && explodeStore && explodeStore.getCount()) {
                    noSplit = explodeStore.getAt(explodeStore.getCount() - 1);
                }
                if (noSplit) {
                    explodeCombo.setValue(noSplit.get(explodeCombo.valueField || 'abbr'));
                    if (explodeCombo.setSelection) { explodeCombo.setSelection(noSplit); }
                }
            }
            objectsStore.getRoot().cascadeBy(function (node) {
                if (node.get('vehid')) {
                    node.set('checked', ids.indexOf(Number(node.get('vehid'))) !== -1);
                }
            });
            reports.reportFormSubmit();
        }

        // objectsStore.isLoaded() puede ser true con getCount()===0: los
        // hijos del root se cargan lazy vía XHR (tree.php?node=root, ~1.4 s).
        // Marcar+submitear antes de eso da 0 seleccionados ("Seleccione 1 o
        // más objetos"). Se espera a que el árbol tenga nodos reales:
        // listener 'load' con guard de count y un poll de respaldo por si el
        // store ya está poblado y no vuelve a emitir 'load'.
        var objectsReady = function () {
            return objectsStore.getCount() > 0;
        };
        var whenObjectsReady = function (done) {
            if (objectsReady()) { done(); return; }
            var settled = false;
            var poll, giveUp;
            function onLoad() { check(); }
            function check() {
                if (settled || !objectsReady()) { return; }
                settled = true;
                objectsStore.un('load', onLoad);
                clearInterval(poll);
                clearTimeout(giveUp);
                done();
            }
            objectsStore.on('load', onLoad);
            poll = setInterval(check, 200);
            giveUp = setTimeout(function () {
                if (settled) { return; }
                settled = true;
                objectsStore.un('load', onLoad);
                clearInterval(poll);
                console.warn('[promatic_dashboard_enhancer] runNativeReport: el árbol de objetos ' +
                    'no cargó en 10s — se intenta el submit igual');
                done();
            }, 10000);
            objectsStore.load();
        };

        var afterReportStore = function () {
            whenObjectsReady(submitWhenReady);
        };

        if (!reportStore.isLoaded()) {
            reportStore.load({ callback: afterReportStore });
        } else {
            afterReportStore();
        }
    },

    /**
     * Click de una tarjeta de Alertas Generales con incidencias:
     * - Accidentes: abre la tabla propia (events.php type=4911 no tiene
     *   report_type nativo equivalente).
     * - Ralentí y otras: no hay report_type que sirva sin group=6, así que
     *   solo se activa el panel Informes con esos vehículos marcados y el
     *   usuario elige el informe. El data-alert-report opcional lleva el
     *   report_type cuando se conoce.
     */
    bindAlertReportLinks: function (panel) {
        var me = this;
        var el = panel && panel.getEl && panel.getEl();
        if (!el || el._alertReportBound) { return; }
        el._alertReportBound = true;
        el.on('click', function (e) {
            // Los chips de "Sin Señal GPS" (data-gps-bucket) viven fuera de
            // [data-alert-ids]: se revisan primero e independientemente. Si
            // no, el early-return de abajo (falta de data-alert-ids en el
            // target) nunca deja llegar a este bloque y el modal no abre.
            var gpsChip = e.getTarget('[data-gps-bucket]', 8, true);
            if (gpsChip) {
                e.preventDefault();
                var bucket = gpsChip.getAttribute('data-gps-bucket');
                var meta = me._GPS_BUCKET_META[bucket];
                if (!meta) { return; }
                var gpsRows = (me._lastGpsBuckets && me._lastGpsBuckets[meta.rowsKey]) || [];
                var gpsMapPoints = gpsRows
                    .filter(function (r) { return r.lat != null && r.lon != null; })
                    .map(function (r) { return { lat: r.lat, lon: r.lon, label: me.displayName(r.veh) }; });
                me.openReportModal(me.buildGpsSignalReport(bucket), meta.title,
                    me._safe(function () { return me.buildGpsSignalPdfDoc(bucket); }),
                    gpsMapPoints);
                return;
            }

            var fuelEl = e.getTarget('[data-fuel-alert]', 8, true);
            if (fuelEl) {
                e.preventDefault();
                me.openFuelAlertModal(fuelEl.getAttribute('data-fuel-alert'));
                return;
            }

            var a = e.getTarget('[data-alert-ids]', 8, true);
            if (!a) { return; }
            e.preventDefault();

            // Accidentes abre la tabla propia en vez de runNativeReport (que
            // llevaría a otro reporte, "Speed violations"). Se detecta por la
            // clase de ícono de la card y no por data-alert-report, que ya no
            // se emite para esta card.
            if (a.hasCls && a.hasCls('promatic_dashboard_enhancer-stat-card--clickable') &&
                a.dom && a.dom.querySelector('.pde_alert-accidentes')) {
                var accMap = me.accidentesMapSetup();
                me.openReportModal(me.buildAccidentesReport(), l('Detalle Alarma de Posibles Accidentes'),
                    me._safe(function () { return me.buildAccidentesPdfDoc(); }),
                    accMap.points, accMap.opts);
                return;
            }

            // Salida de territorio nacional: tabla propia (la notificación no
            // tiene un report_type nativo equivalente).
            if (me._alertBorderEnabled && a.hasCls && a.hasCls('promatic_dashboard_enhancer-stat-card--clickable') &&
                a.dom && a.dom.querySelector('.pde_alert-fuerazona')) {
                var borderHtml = me.buildBorderAlertReport();
                me.openReportModal(borderHtml, l('Detalle Salida de Territorio Nacional'), null,
                    me._borderModalPoints || []);
                return;
            }

            var raw = a.getAttribute('data-alert-ids');
            var ids = (raw || '').split(',').map(Number).filter(function (n) { return !isNaN(n) && n > 0; });
            if (!ids.length) { return; }
            var rt = Number(a.getAttribute('data-alert-report'));
            var range = me._alertRange || {};
            if (rt && range.start && range.stop) {
                if (!me.activateReportsTab()) { return; }
                Ext.defer(function () {
                    try { me.runNativeReport(rt, ids, range.start, range.stop); }
                    catch (err) {
                        console.warn('[promatic_dashboard_enhancer] informe de alerta falló, se marca la selección:', err);
                        me.selectVehiclesInReports(ids);
                    }
                }, 200);
            } else {
                me.selectVehiclesInReports(ids);
            }
        });
    },

    /**
     * Activa el tab Informes y marca solo `ids` en el árbol de objetos, sin
     * elegir report_type ni submitear. Reusa la espera de runNativeReport en
     * una versión mínima inline.
     */
    selectVehiclesInReports: function (ids) {
        var me = this;
        if (!this.activateReportsTab()) {
            console.warn('[promatic_dashboard_enhancer] selectVehiclesInReports: no se pudo activar Informes');
            return;
        }
        var want = ids.map(Number);
        var attempt = 0;
        var tryMark = function () {
            var reports = window.skeleton && skeleton.navigation && skeleton.navigation.reports;
            var tree = reports && reports.down && reports.down('#reports_objects_tree');
            var store = tree && tree.getStore && tree.getStore();
            if (!store || store.getCount() === 0) {
                if (attempt++ < 30) { Ext.defer(tryMark, 250); }
                else { console.warn('[promatic_dashboard_enhancer] selectVehiclesInReports: árbol de objetos no cargó'); }
                if (store && store.getCount() === 0 && attempt === 1) { try { store.load(); } catch (e) {} }
                return;
            }
            var marked = 0;
            store.getRoot().cascadeBy(function (node) {
                var vid = node.get('vehid');
                if (vid != null) {
                    var on = want.indexOf(Number(vid)) !== -1;
                    node.set('checked', on);
                    if (on) { marked++; }
                }
            });
            Store.promatic_dashboard_enhancer.Module.debugLog('selectVehiclesInReports: ' + marked + '/' + want.length +
                ' vehículos marcados en el panel Informes — elige el informe a generar');
        };
        Ext.defer(tryMark, 200);
    },

    getModuleBaseUrl: function () {
        var scripts = document.getElementsByTagName('script');
        for (var i = scripts.length - 1; i >= 0; i--) {
            var src = scripts[i].src || '';
            if (src.indexOf('/Module.js') !== -1) {
                return src.substring(0, src.lastIndexOf('/') + 1);
            }
        }
        return '/store/promatic_dashboard_enhancer/';
    },

    /**
     * Carga config.json y lo mergea (por sección, un nivel) sobre
     * DEFAULT_CONFIG. No bloquea el arranque: los widgets corren en el
     * 'afterrender' del panel (bastante después de initModule), así que
     * normalmente ya resolvió; si no, usan el default. Al final encadena
     * loadRemoteConfig(), que puede sobrescribir secciones con la config
     * remota.
     */
    loadConfig: function () {
        var me = this;
        var url = this.getModuleBaseUrl() + 'config.json?v=' + this.moduleBuild;

        return fetch(url, { credentials: 'same-origin' })
            .then(function (resp) {
                if (!resp.ok) { throw new Error('HTTP ' + resp.status); }
                return resp.json();
            })
            .then(function (json) {
                var merged = {};
                var section;
                for (section in me.DEFAULT_CONFIG) {
                    if (me.DEFAULT_CONFIG.hasOwnProperty(section)) {
                        merged[section] = Ext.apply({}, me.DEFAULT_CONFIG[section]);
                    }
                }
                for (section in json) {
                    if (json.hasOwnProperty(section) && section.charAt(0) !== '_' &&
                        json[section] && typeof json[section] === 'object') {
                        merged[section] = Ext.apply(merged[section] || {}, json[section]);
                    }
                }
                me.config = merged;
                Store.promatic_dashboard_enhancer.Module.debugLog('config.json cargado', merged);
            })
            .catch(function (err) {
                me.config = me.DEFAULT_CONFIG;
                console.warn('[promatic_dashboard_enhancer] config.json no cargó (' +
                    (err && err.message ? err.message : err) + ') — usando DEFAULT_CONFIG');
            })
            .then(function () { return me.loadRemoteConfig(); })
            .then(function () {
                // Si la config (local o remota) llegó después del primer
                // render, la vista puede ser distinta de la que se aplicó.
                if (me._activePreset && me.effectiveUiPreset() !== me._activePreset) { me.applyViewPreset(); }
            });
    },

    sha256Hex: function (text) {
        return crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)).then(function (buf) {
            return Array.prototype.map.call(new Uint8Array(buf), function (b) {
                return ('0' + b.toString(16)).slice(-2);
            }).join('');
        });
    },

    loadRemoteConfig: function () {
        var me = this;
        var remote = (me.config && me.config.remoteConfig) || {};
        if (!remote.url || !remote.key || !window.crypto || !crypto.subtle) { return Promise.resolve(); }

        return fetch('/backend/ax/user/tokens.php?page=1&start=0&limit=25', { credentials: 'same-origin' })
            .then(function (resp) {
                if (!resp.ok) { throw new Error('tokens HTTP ' + resp.status); }
                return resp.json();
            })
            .then(function (list) {
                var tokens = (Array.isArray(list) ? list : []).filter(function (t) { return t && t.token; });
                if (tokens.length === 0) { throw new Error('sin tokens visibles'); }
                return Promise.all(tokens.map(function (t) { return me.sha256Hex(String(t.token)); }));
            })
            .then(function (hashes) {
                return fetch(remote.url + '/rest/v1/rpc/get_config', {
                    method: 'POST',
                    headers: {
                        'apikey': remote.key,
                        'Authorization': 'Bearer ' + remote.key,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({ hashes: hashes })
                });
            })
            .then(function (resp) {
                if (!resp.ok) { throw new Error('config remota HTTP ' + resp.status); }
                return resp.json();
            })
            .then(function (json) {
                if (!json || typeof json !== 'object') { return; }
                var merged = {};
                var section;
                for (section in me.config) {
                    if (me.config.hasOwnProperty(section)) {
                        merged[section] = Ext.apply({}, me.config[section]);
                    }
                }
                for (section in json) {
                    if (json.hasOwnProperty(section) && section.charAt(0) !== '_' &&
                        section !== 'remoteConfig' && json[section] && typeof json[section] === 'object') {
                        merged[section] = Ext.apply(merged[section] || {}, json[section]);
                    }
                }
                me.config = merged;
                Store.promatic_dashboard_enhancer.Module.debugLog('config remota aplicada');
            })
            .catch(function (err) {
                console.warn('[promatic_dashboard_enhancer] config remota no disponible (' +
                    (err && err.message ? err.message : err) + ') — se mantiene config.json');
            });
    },

    loadStyles: function () {
        var css = document.createElement('link');
        css.setAttribute('rel', 'stylesheet');
        css.setAttribute('type', 'text/css');
        css.setAttribute('href', this.getModuleBaseUrl() + 'style.css?v=' + this.moduleBuild);
        document.head.appendChild(css);
    }
});
