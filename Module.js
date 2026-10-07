Ext.define('Store.promatic_dashboard_enhancer.Module', {
    extend: 'Ext.Component',
    extensionName: 'promatic_dashboard_enhancer',
    // version es el SemVer de release y se sube a mano: minor por lote de
    // cambios o widget nuevo, patch por fix puntual. moduleBuild (fecha+hora)
    // lo escribe el script de publicación en cada publicación: es el cache-
    // busting del CSS y la traza en consola. No es la versión.
    version: '0.25.0',
    moduleBuild: '2026-10-07-1224',

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
        // scope 'pilot-selection': los widgets siguen la selección con
        // checkbox del panel "Principal" de PILOT. 'all': árbol Online
        // completo. El slider del pie sobrescribe este valor por sesión
        // (localStorage).
        //
        // maxVehicles es el tope de seguridad para no disparar jobs
        // asíncronos en flotas enormes. El corte es ciego (primeros N del
        // árbol, no por relevancia), así que con flotas mayores al tope
        // varios widgets trabajan sobre una muestra parcial.
        fleet: { scope: 'pilot-selection', maxVehicles: 1500 },
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
        hotspots: { windowDays: 30, minGapSeconds: 120, shortGapMinSeconds: 10, shortGapMaxSeconds: 90 }
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
            cls: 'promatic_dashboard_enhancer-panel',
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
                        me.loadTop5KmData();
                        me.loadAlertasGenerales();
                        me.loadEcoScore();
                        me.loadViolationsTrend();
                        // Mapa de hotspots: instancia propia de MapContainer
                        // dentro de un Ext.panel.Panel (patrón del ejemplo
                        // oficial examples/airports/Map.js). El listener
                        // 'render' del panel crea el MapContainer y carga los
                        // datos. NUNCA toca window.mapContainer, que es el
                        // mapa global de PILOT.
                        me.buildHotspotsMapPanel();
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
            cls: 'promatic_dashboard_enhancer-card' + (opts.grow2 ? ' promatic_dashboard_enhancer-card--grow-2' : ''),
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
        })[which] || l('Reporte');
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
     */
    openReportModal: function (html, title, pdfDoc, mapPoints) {
        var me = this;
        this.closeReportModal();

        // "Descargar PDF" se ofrece siempre que haya docDefinition. pdfMake
        // suele estar en el runtime de PILOT; si no, se carga bajo demanda al
        // hacer clic (ver ensurePdfMake).
        var pdfBtn = pdfDoc
            ? '<button type="button" data-act="pdf" class="promatic_dashboard_enhancer-report-modal__btn promatic_dashboard_enhancer-report-modal__btn--primary">⬇ ' + l('Descargar PDF') + '</button>'
            : '';

        var hasMap = Array.isArray(mapPoints) && mapPoints.length > 0;
        var mapHtml = hasMap
            ? '<div id="promatic_dashboard_enhancer-report-modal-map" class="promatic_dashboard_enhancer-report-modal__map"></div>'
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

        if (hasMap) {
            me._buildReportModalMap(mapPoints);
            // Mensajes del iframe (click en "ver en mapa interno" de una
            // fila): centran/zoom al punto pedido. Un solo listener por
            // apertura del modal; se limpia en closeReportModal.
            me._reportModalMsgHandler = function (ev) {
                if (ev.source !== frame.contentWindow) { return; }
                var data = ev.data || {};
                if (data.type !== 'promatic_dashboard_enhancer_focus_point') { return; }
                me._focusReportModalMapPoint(data.lat, data.lon);
            };
            window.addEventListener('message', me._reportModalMsgHandler);
        }

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
    _buildReportModalMap: function (mapPoints) {
        var me = this;
        var body = Ext.get('promatic_dashboard_enhancer-report-modal-map');
        if (!body || !me.getMapContainerClass()) {
            if (body) { body.setHtml(l('El mapa no está disponible en este runtime.')); }
            return;
        }
        me._reportModalMapPoints = mapPoints;
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
                        var first = mapPoints[0];
                        me._reportModalMap.init(first.lat, first.lon, 12, this.id + '-body', false);
                        for (var i = 0; i < mapPoints.length; i++) {
                            var p = mapPoints[i];
                            me._reportModalMap.addMarker({
                                id: 'promatic_dashboard_enhancer_report_modal_marker_' + i,
                                lat: p.lat, lon: p.lon,
                                size: 'mini',
                                tooltip: p.label ? { msg: p.label, options: { direction: 'top' } } : undefined
                            });
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

    _focusReportModalMapPoint: function (lat, lon) {
        var map = this._reportModalMap;
        if (!map || !map.setMapCenter || lat == null || lon == null) { return; }
        try { map.setMapCenter(lat, lon, { zoom: 16 }); }
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
            '@media print{body{padding:14mm}h2{page-break-after:avoid}table,.grid,.guide{page-break-inside:avoid}}' +
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
                (this._alertBorderEnabled ? mk(l('Salida de territorio nacional'), this._alertBorder) : '') +
                '</table><p class="sub">' + (this._alertBorderEnabled
                    ? l('Categorías beta (combustible, GPS manipulado) aún sin fuente conectada.')
                    : l('Categorías beta (combustible, GPS manipulado, territorio nacional) aún sin fuente conectada.')) + '</p>';
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
        var descHtml = desc ? '<p class="desc">' + l(desc) + '</p>' : '';

        return '<!doctype html><html><head><meta charset="utf-8"><title>' + title +
            '</title>' + this._reportStyles() + '</head><body>' +
            this._reportHeader(title, days) + descHtml + body +
            '<div class="foot">' +
            l('Reporte generado por el Dashboard sobre datos de PILOT Telematics. Para ver la información al detalle por evento, revisa el panel Informes de PILOT (ver la guía en el Golden Report).') +
            '</div></body></html>';
    },

    /**
     * Detalle de accidentes reales (events.php type=4911): 1 fila por evento
     * "Real crash detected" en la ventana de loadAlertasGenerales. Sin
     * geocoding inverso (Ubicación muestra lat/lon + link a Google Maps) y
     * sin link a un informe nativo por fila: no existe un report_type ni un
     * objeto de navegación equivalente a este árbol de eventos.
     */
    buildAccidentesReport: function () {
        var me = this;
        var esc = Ext.String.htmlEncode;
        var rows = this._alertAccidentesRows || [];
        var days = 30;
        var title = l('Detalle Alarma de Posibles Accidentes');

        // Recientes (hoy/ayer, en la zona horaria configurada) vs. histórico
        // del resto de la ventana: evita tener que buscar los accidentes más
        // urgentes entre decenas de filas.
        var todayKey = this._eventDayKey(Math.floor(Date.now() / 1000));
        var yesterdayKey = this._eventDayKey(Math.floor(Date.now() / 1000) - 86400);
        var isRecent = function (r) {
            var k = me._eventDayKey(r.ts);
            return k === todayKey || k === yesterdayKey;
        };

        var rowHtml = function (r) {
            var link = me._mapsLink(r.lat, r.lon);
            var locCell;
            if (r.lat != null && r.lon != null) {
                locCell = r.lat.toFixed(5) + ', ' + r.lon.toFixed(5) +
                    ' — <button type="button" class="promatic_dashboard_enhancer-focus-btn" data-focus-lat="' + r.lat + '" data-focus-lon="' + r.lon + '">' + l('ver en mapa interno') + '</button>' +
                    (link ? ' — <a href="' + esc(link) + '" target="_blank" rel="noopener">' + l('ver en mapa') + ' ↗</a>' : '');
            } else {
                locCell = l('N/D');
            }
            var calCell = r.calibrated === false ? l('No') : l('Sí');
            return '<tr><td>' + esc(me._fmtEventDateTime(r.ts)) + '</td><td>' +
                esc(me.displayName(r.veh)) + '</td><td>' + calCell + '</td><td>' + locCell + '</td></tr>';
        };
        var tableHtml = function (list) {
            var h = '<table id="promatic_dashboard_enhancer-accidentes-table"><tr><th>' + l('Fecha y hora') + '</th><th>' + l('Vehículo') +
                '</th><th>' + l('Calibrado') + '</th><th>' + l('Ubicación') + '</th></tr>';
            for (var i = 0; i < list.length; i++) { h += rowHtml(list[i]); }
            return h + '</table>';
        };

        var body;
        if (!rows.length) {
            body = '<p>' + l('Sin accidentes reales detectados en el período.') + '</p>';
        } else {
            var sorted = rows.slice().sort(function (a, b) { return (b.ts || 0) - (a.ts || 0); });
            var recent = sorted.filter(isRecent);
            var historic = sorted.filter(function (r) { return !isRecent(r); });
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
        var desc = '<p class="desc">' + l('Alarmas de eventos de posible colisión detectadas por el acelerómetro. Cada fila es una alerta generada de un potencial accidente real, sin agregar ni incluir el ruido de detección repetida. La columna Calibrado indica si el sensor completó su calibración al momento de la detección. Total: ' + rows.length + '.') + '</p>' +
            '<p class="desc">' + l('Fuente: events.php type=4911') + '</p>';

        // El iframe es un documento aislado sin acceso al MapContainer del
        // padre: el punto elegido viaja por postMessage y openReportModal
        // (padre) centra el mapa que vive fuera del iframe.
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
            l('Reporte generado por el Dashboard sobre datos de PILOT Telematics. PILOT no expone hoy un informe nativo equivalente a este listado — este reporte sirve como base para reportar el requerimiento a Pilot Telematics.') +
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
            row(l('Ralentí excesivo'), this._alertRalenti) + '</table>';

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
        var doc = this._pdfBase(this._widgetReportName(which),
            this._pdfRange(which === 'eco' ? (((this.config && this.config.ecoScore) || this.DEFAULT_CONFIG.ecoScore).windowDays || 8) : 7));
        var desc = this._widgetDescriptions[which];
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
            ]));
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
            C.push(this._pdfTable([l('Fecha y hora'), l('Vehículo'), l('Calibrado'), l('Ubicación')],
                sorted.map(function (r) {
                    var loc = (r.lat != null && r.lon != null) ? (r.lat.toFixed(5) + ', ' + r.lon.toFixed(5)) : l('N/D');
                    var cal = r.calibrated === false ? l('No') : l('Sí');
                    return [me._fmtEventDateTime(r.ts), name(r.veh), cal, loc];
                })));
        }
        C.push({ text: l('Reporte generado por el Dashboard sobre datos de PILOT Telematics — sin informe nativo equivalente disponible en PILOT.'), style: 'foot' });
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
            ]
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
            ]
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
     * - Slider de alcance de 2 posiciones explícitas: "Selección Principal"
     *   sigue los checkboxes del panel "Principal" de PILOT; "Toda la flota"
     *   los ignora. Es slider y no botón toggle a propósito: el estado se lee
     *   de la posición del thumb, sin ambigüedad de "¿avanza o retrocede al
     *   hacer click?". El override vive en localStorage.
     * - Actualizar widgets: re-dispara todos los widgets sin recargar y sella
     *   la hora en la barra de resumen.
     */
    controlsBarMarkup: function () {
        var isSelection = this.effectiveFleetScope() === 'pilot-selection';
        return {
            cls: 'promatic_dashboard_enhancer-controls',
            cn: [
                {
                    id: 'promatic_dashboard_enhancer-scope-slider',
                    cls: 'promatic_dashboard_enhancer-scope' +
                        (isSelection ? '' : ' is-all'),
                    role: 'switch',
                    cn: [
                        {
                            tag: 'span',
                            cls: 'promatic_dashboard_enhancer-scope__opt promatic_dashboard_enhancer-scope__opt--sel',
                            html: l('Selección Principal')
                        },
                        { tag: 'span', cls: 'promatic_dashboard_enhancer-scope__track', cn: [
                            { tag: 'span', cls: 'promatic_dashboard_enhancer-scope__thumb' }
                        ] },
                        {
                            tag: 'span',
                            cls: 'promatic_dashboard_enhancer-scope__opt promatic_dashboard_enhancer-scope__opt--all',
                            html: l('Toda la flota')
                        }
                    ]
                },
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

    // Refleja el estado efectivo en la posición del slider.
    syncScopeSlider: function () {
        var sl = Ext.get('promatic_dashboard_enhancer-scope-slider');
        if (sl) {
            sl[this.effectiveFleetScope() === 'pilot-selection' ? 'removeCls' : 'addCls']('is-all');
        }
    },

    /**
     * Fija el alcance a un modo explícito ('pilot-selection' | 'all').
     * 'pilot-selection' limpia el override (es el default de config); 'all'
     * lo escribe.
     */
    setScopeMode: function (mode) {
        if (mode === this.effectiveFleetScope()) { return; }
        this.setScopeOverride(mode === 'all' ? 'all' : null);
        this.syncScopeSlider();
        this.refreshAllWidgets();
    },

    /**
     * Re-corre todos los widgets con datos en vivo (no toca reloj/logo) y
     * sella la hora del último refresco manual. Esa hora se muestra en la
     * barra de resumen; antes se re-pintaba en cada datachanged del árbol y
     * parecía un reloj.
     */
    refreshAllWidgets: function () {
        this._lastManualRefresh = new Date();
        // Feedback visible de "recalculando": el mismo skeleton del montaje,
        // en cada card afectada antes de la recarga.
        this.showCardSkeleton('gps_signal', 'chips');
        this.showCardSkeleton('top5km', 'ranking');
        this.showCardSkeleton('flota', 'donut');
        this.showCardSkeleton('eco_score', 'donut');
        this.showCardSkeleton('alertas_generales', 'stats');
        this.showCardSkeleton('violations', 'stats');
        this.refreshFleetStore();
        this.loadTop5KmData();
        this.loadAlertasGenerales();
        this.loadEcoScore();
        this.loadViolationsTrend();
        // El dropdown puede tener carpetas nuevas si cambió la selección.
        this.populateMapFolderDropdown();
        this.loadFleetHeatmap();
        this.populateFleetMapFolderDropdown();
        this.loadFleetMapClusters();
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
            if (me._autoRefreshBusy) { return; }
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
        this.updateCardBody(id, Ext.DomHelper.markup(this.skeletonSpec(kind)), 0, true);
    },

    bindControlsBar: function (panel) {
        var me = this;
        var el = panel && panel.getEl && panel.getEl();
        if (!el || el._controlsBound) { return; }
        el._controlsBound = true;

        el.on('click', function (e) {
            var slider = e.getTarget('#promatic_dashboard_enhancer-scope-slider', 5, true);
            if (slider) {
                e.preventDefault();
                // El lado clickeado decide el modo (no un toggle ciego).
                var allOpt = e.getTarget('.promatic_dashboard_enhancer-scope__opt--all', 3, true);
                var selOpt = e.getTarget('.promatic_dashboard_enhancer-scope__opt--sel', 3, true);
                if (allOpt) {
                    me.setScopeMode('all');
                } else if (selOpt) {
                    me.setScopeMode('pilot-selection');
                } else {
                    // click en el track/thumb: alterna al otro lado
                    me.setScopeMode(me.effectiveFleetScope() === 'pilot-selection' ? 'all' : 'pilot-selection');
                }
                return;
            }
            var refreshBtn = e.getTarget('#promatic_dashboard_enhancer-btn-refresh', 5, true);
            if (refreshBtn) {
                e.preventDefault();
                refreshBtn.addCls('promatic_dashboard_enhancer-ctrl-btn--busy');
                me.refreshAllWidgets();
                Ext.defer(function () {
                    var b = Ext.get('promatic_dashboard_enhancer-btn-refresh');
                    if (b) { b.removeCls('promatic_dashboard_enhancer-ctrl-btn--busy'); }
                }, 800);
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

        this.syncScopeSlider();
        this.applyScalePct(this.getScalePct());
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

    // Alcance del dashboard operable desde el slider del pie: 'pilot-
    // selection' sigue la selección con checkbox del panel "Principal"; 'all'
    // usa la flota completa del árbol Online.
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
     * Alcance efectivo: el slider (localStorage) gana sobre
     * config.fleet.scope.
     */
    effectiveFleetScope: function () {
        var override = this.getScopeOverride();
        if (override === 'all' || override === 'pilot-selection') {
            return override;
        }
        var fleetCfg = (this.config && this.config.fleet) || this.DEFAULT_CONFIG.fleet;
        return fleetCfg.scope || 'all';
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
            console.log('[promatic_dashboard_enhancer] flota: total=' + total +
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
     *   ptm no está confirmado en una cuenta con datos; el console.log del
     *   raw sirve para verificarlo. Si una categoría falla muestra "N/D" sin
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
                console.log('[promatic_dashboard_enhancer] alertas generales: accidentes=' +
                    r[0] + ' requiere_mantencion=' + r[1] + ' paso_fronterizo=' + r[2]);
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
                console.log('[promatic_dashboard_enhancer] accidentes (events.php type=4911):', tree);
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
                console.log('[promatic_dashboard_enhancer] paso fronterizo (events.php type=' + eventType + '):', tree);
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
                                lon: ev.lon != null ? Number(ev.lon) : null
                            });
                        }
                    }
                }
                return rows;
            })
            .finally(function () { clearTimeout(to); });
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
                    console.log('[promatic_dashboard_enhancer] mantención sondeo ' + endpoints[i].url + ':', data);
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
                card('var(--g7)', l('Inconsistencias en Carga'), null, svgCombustible,
                    l('Carga de combustible fuera de lo esperado — pendiente de conexión'), true, 'pde_alert-inconsistencias'),
                card('var(--g6)', l('Drenaje de Combustible'), null, svgCombustible,
                    l('Baja brusca de combustible que no corresponde a una recarga — pendiente de conexión'), true, 'pde_alert-drenaje'),
                card('var(--g7)', l('GPS Manipulado'), null, svgGpsManual,
                    l('Desconexión intencional del equipo — pendiente de conexión'), true, 'pde_alert-manipulacion'),
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

        console.log('[promatic_dashboard_enhancer] eco score (report_type=223): ' + rows.length +
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
                        me.loadFleetHeatmap();
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

                    console.log('[promatic_dashboard_enhancer] hotspots desconexión: ' + rawPoints.length +
                        ' cortes totales (report_type=73, ' + windowDays + 'd) — ' +
                        countLong + ' largos (>' + minGapSeconds + 's, ' + me._hotspotsPointsByMode.long.length + ' celdas), ' +
                        countShort + ' breves (' + shortMin + '-' + shortMax + 's, ' + me._hotspotsPointsByMode.short.length + ' celdas)' +
                        (me._mapFolderFilter ? ' (carpeta ' + me._mapFolderFilter + ')' : ''));

                    me._paintHotspotsHeatmap();
                })
                .catch(function (err) {
                    me._showHotspotsMapLoading(false);
                    me.widgetErrorCode('FLEETMAP-HEATMAP-FETCH', err);
                });
        });
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

        try {
            if (typeof map.removeAllHeatsMap === 'function') { map.removeAllHeatsMap(); }
        } catch (e) { /* no-op */ }

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
                map.setHeatmap(points, false, label);
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

        console.log('[promatic_dashboard_enhancer] ubicación global de la flota: ' + records.length +
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
            // 'circle' no es un polígono (points = [lat, lon, radioM]); sin
            // soporte de ray casting para círculos todavía, se salta.
            if (g.type === 'circle') { continue; }
            var points = this._geofencePolygonPoints(g);
            if (!points || points.length < 3) { continue; }
            if (this._pointInPolygon(ll[0], ll[1], points)) {
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

        console.log('[promatic_dashboard_enhancer] vehículos por sucursal: "' + geofence.name +
            '" — ' + matches.length + ' de ' + records.length + ' vehículos en alcance');

        var mount = Ext.get('promatic_dashboard_enhancer-branch-veh-list-mount');
        if (mount) { mount.setHtml(listHtml); }
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

            console.log('[promatic_dashboard_enhancer] Top KM: ' + vehIds.length +
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
                        console.log('[promatic_dashboard_enhancer] Top KM servido por: reports');
                    });
            };
            var runRatings = function () {
                return me.fetchAnalyticsMainData(csv, 15000,
                    startDate.toISOString().slice(0, 19), stopDate.toISOString().slice(0, 19))
                    .then(function (mainData) {
                        if (stale()) { return; }
                        me.renderTop5Km(me.parseRatingsTop5(mainData), days, startDate, stopDate, count);
                        console.log('[promatic_dashboard_enhancer] Top KM servido por: ratings');
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
                        console.log('[promatic_dashboard_enhancer] Top KM servido por: trips-v3 (' +
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

            var a = e.getTarget('[data-alert-ids]', 8, true);
            if (!a) { return; }
            e.preventDefault();

            // Accidentes abre la tabla propia en vez de runNativeReport (que
            // llevaría a otro reporte, "Speed violations"). Se detecta por la
            // clase de ícono de la card y no por data-alert-report, que ya no
            // se emite para esta card.
            if (a.hasCls && a.hasCls('promatic_dashboard_enhancer-stat-card--clickable') &&
                a.dom && a.dom.querySelector('.pde_alert-accidentes')) {
                var accidentesRows = me._alertAccidentesRows || [];
                var accidentesMapPoints = accidentesRows
                    .filter(function (r) { return r.lat != null && r.lon != null; })
                    .map(function (r) { return { lat: r.lat, lon: r.lon, label: me.displayName(r.veh) }; });
                me.openReportModal(me.buildAccidentesReport(), l('Detalle Alarma de Posibles Accidentes'),
                    me._safe(function () { return me.buildAccidentesPdfDoc(); }),
                    accidentesMapPoints);
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
            console.log('[promatic_dashboard_enhancer] selectVehiclesInReports: ' + marked + '/' + want.length +
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
                console.log('[promatic_dashboard_enhancer] config.json cargado', merged);
            })
            .catch(function (err) {
                me.config = me.DEFAULT_CONFIG;
                console.warn('[promatic_dashboard_enhancer] config.json no cargó (' +
                    (err && err.message ? err.message : err) + ') — usando DEFAULT_CONFIG');
            })
            .then(function () { return me.loadRemoteConfig(); });
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
                console.log('[promatic_dashboard_enhancer] config remota aplicada');
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
