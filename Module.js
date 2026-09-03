Ext.define('Store.promatic_dashboard_enhancer.Module', {
    extend: 'Ext.Component',
    extensionName: 'promatic_dashboard_enhancer',
    // version: SemVer de release, se sube a mano (ver brain/INT-006).
    //   minor = lote de feedback / widget nuevo · patch = fix puntual.
    // moduleBuild: fecha+hora, lo bumpea publish-plugin.sh en cada --execute
    //   (cache-busting de style.css + traza en consola). No es la versión.
    version: '0.5.0',
    moduleBuild: '2026-09-03-1859',

    // Config runtime — fallback si dist/config.json no carga. loadConfig()
    // pisa estos valores con lo que traiga el JSON (mismo shape). A futuro
    // un backend puede servir el mismo shape y sobrescribir en caliente
    // (ver stub en loadConfig). Cambiar acá = requiere re-publicar; cambiar
    // en config.json = igual requiere re-publicar hoy, pero deja el punto
    // de extensión listo para el override remoto.
    DEFAULT_CONFIG: {
        top5km: { windowDays: 7, activeVehicleCap: 300, tripsMaxVehicles: 100, tripsBatchSize: 4, source: 'trips-v3', count: 5, kmField: 'gps' },
        // fleet.scope: 'pilot-selection' = los widgets siguen la selección
        // con checkbox del panel "Principal" de PILOT (online_tree.getChecked()).
        // 'all' = árbol Online completo. El slider del pie del dashboard
        // sobrescribe este valor por sesión (localStorage). maxVehicles =
        // tope de seguridad para no disparar jobs async en flotas enormes.
        fleet: { scope: 'pilot-selection', maxVehicles: 500 },
        // Widget "Hora Oficial" — zona horaria IANA y locale para formatear.
        clock: { timeZone: 'America/Santiago', locale: 'es-CL', label: 'Hora Oficial' }
    },

    initModule: function () {
        console.log('[promatic_dashboard_enhancer] BUILD ' + this.moduleBuild + ' — initModule: inicio');
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
            title: l('Promatic Dashboard'),
            iconCls: 'fa fa-th-large',
            iconAlign: 'top',
            minimized: true,
            items: [mainPanel]
        });
    },

    // -----------------------------------------------------------------------
    // Layout principal — shell de filas flex (HTML plano vía Ext.DomHelper,
    // sin Ext.container.Container anidado). El sistema de grid CSS de ADR-007
    // (buildLegacyWidgetGrid + wrapWidget + los widgets Ext.panel.Panel) se
    // retiró el 28 ago — ver DEP-003 y BR-PILOT-0006.
    // -----------------------------------------------------------------------

    buildMainPanel: function () {
        this.summaryBar = Ext.create('Ext.Component', {
            cls: 'promatic_dashboard_enhancer-summary',
            html: l('Cargando estado de flota...')
        });

        // RAC primero (27 ago, pedido del usuario) — buildLopShell() queda
        // intacto sin invocar como rollback rápido. LOC será una
        // reorganización de estos mismos widgets vía configuración externa
        // (JSON o consulta a BD) — diseño todavía pendiente, no implementado.
        var me = this;

        // El panel de una extensión se monta lazy: Ext no crea su DOM hasta
        // que el usuario abre el tab. Si lanzamos los widgets acá (al
        // construir), todos los updateCardBody fallan porque las cards
        // todavía no existen. Se arranca todo en 'afterrender' (una vez),
        // que es exactamente "el DOM del panel ya está".
        var panel = Ext.create('Ext.panel.Panel', {
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
                        me.bindControlsBar(panel);
                        me.bindFleetUpdates();
                        me.loadTop5KmData();
                        me.loadAlertasGenerales();
                        // loadHotspots DESACTIVADO 28 ago: new MapContainer/
                        // setHeatmap afectaba el mapa nativo de PILOT (Online)
                        // en vez de crear uno propio. Nunca verificado en
                        // cuenta real — reactivar tras leer MapContainer.md.
                        me.updateCardBody('hotspots', l('Mapa de desconexión — en integración.'));
                        me.startClock();
                        me.renderLogo();
                    }
                }
            }
        });

        return panel;
    },

    // -----------------------------------------------------------------------
    // Shell vista LOP (26 ago) — solo estructura y placeholders todavía, sin
    // datos ni Highcharts. Filas flex (ver style.css), NO Ext.panel.Panel
    // con layout propio: cada card es un Ext.Component simple con HTML vía
    // Ext.DomHelper, para que Ext no tenga layout de hijos que competir con
    // el CSS. Building block del reemplazo de BR-PILOT-0006 — ver
    // spec/features.md. Reconectar datos widget por widget es el paso
    // siguiente, no parte de este commit.
    // -----------------------------------------------------------------------

    // BR-PILOT-0006 (segunda vuelta, 26 ago): Ext.container.Container con
    // layout 'auto' envuelve cada nivel de hijos en divs propios
    // (outerCt/innerCt, con table-layout:fixed) — confirmado inspeccionando
    // el DOM real en DEMO_CLIENT (brain/files/salida-pilot-v0.5.html). Eso
    // rompe flexbox: el hijo directo de nuestra fila deja de ser la card,
    // pasa a ser el outerCt de Ext. Por eso todo el shell se arma acá como
    // HTML plano (Ext.DomHelper) dentro de UN solo Ext.Component — nada de
    // Ext.container.Container anidado, así el DOM real es exactamente el
    // que escribimos. Actualizar contenido de una card: updateCardBody(id,
    // html), que ubica el nodo por id con Ext.get() — no hay Ext.Component
    // por card, así que no aplica el patrón this.mileageEl.update() del
    // resto del módulo.
    // Skeleton de carga — barras grises con la forma aproximada del
    // contenido real, mientras el widget hace su primer fetch. Reemplazado
    // por updateCardBody() cuando llega el dato (o por el mensaje de error
    // del propio widget si falla). El shimmer se apaga con
    // prefers-reduced-motion (ver style.css). kind:
    //   'donut'   — Estado de Flota (2x2 de cuadrantes con % grande)
    //   'ranking' — Top KM (barra apilada + filas de ranking)
    //   'chips'   — Sin Señal GPS (3 chips en fila)
    //   'stats'   — Alertas Generales (columna de tarjetas)
    //   'map'     — Hotspots (bloque grande)
    // Devuelve un SPEC de Ext.DomHelper (objeto), no un string — se anida
    // como `cn` dentro del spec del card, que buildRacShell renderiza de una
    // sola pasada. Un string HTML acá se re-escaparía en esa pasada.
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
        // (?) con tooltip nativo de Ext (data-qtip) — explica cómo/desde
        // cuándo se lee el dato de la card. QuickTips está activo en el
        // runtime de PILOT.
        if (opts.hint) {
            headCn.push({
                tag: 'span',
                cls: 'promatic_dashboard_enhancer-card__hint',
                'data-qtip': opts.hint,
                title: opts.hint, // fallback si QuickTips no está activo
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

        var cn = [
            { cls: 'promatic_dashboard_enhancer-card__head', cn: headCn },
            bodySpec
        ];
        // Cards puramente informativas (reloj, buscador, logo) no llevan pie
        // "Ver en PILOT" — no hay nada nativo a lo que enlazar.
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

    // Reintento acotado (300ms x 60 = 18s): el shell puede no estar
    // renderizado en el DOM todavía cuando un widget intenta actualizar su
    // card — pasa sobre todo con los que se pintan de una desde
    // buildMainPanel (reloj, logo), antes de que Ext termine de montar el
    // panel y agregarlo a skeleton.navigation. Tope fijo, nunca infinito.
    updateCardBody: function (id, html, attempt) {
        attempt = attempt || 0;
        var el = Ext.get('promatic_dashboard_enhancer-card-body-' + id);
        if (el) {
            el.setHtml(html);
        } else if (attempt < 60) {
            Ext.defer(this.updateCardBody, 300, this, [id, html, attempt + 1]);
        } else {
            console.warn('[promatic_dashboard_enhancer] updateCardBody("' + id +
                '"): la card no apareció en el DOM tras 18s.');
        }
    },

    rowMarkup: function (cardSpecs) {
        return { cls: 'promatic_dashboard_enhancer-row', cn: cardSpecs };
    },

    // Apila 2+ cards en una sola celda de la fila (ver .promatic_dashboard_enhancer-col
    // en style.css) — usado en el shell RAC para que Señal GPS + Alertas
    // Generales compartan el ancho de una columna en vez de tener cada una
    // la suya. Sigue siendo HTML plano vía DomHelper, nada de
    // Ext.container.Container anidado (BR-PILOT-0006).
    colMarkup: function (cardSpecs) {
        return { cls: 'promatic_dashboard_enhancer-col', cn: cardSpecs };
    },

    // -----------------------------------------------------------------------
    // Shell vista RAC (27 ago) — vista activa por defecto ahora ("RAC
    // primero", pedido del usuario). Mismo mecanismo que buildLopShell: HTML
    // plano vía Ext.DomHelper dentro de un único Ext.Component. Reutiliza
    // los ids 'flota'/'top5km'/'hotspots' del shell LOP a propósito — mismo
    // dato exacto, y solo un shell está montado a la vez, así que no hay
    // colisión de ids en el DOM real. Señal GPS se separó de Alertas
    // Generales en 2 widgets (antes 1 solo "Últimas Alertas de Vehículos")
    // porque GPS/desconexión es la única alerta que aparece igual en todo
    // panel sin importar el tipo de negocio del cliente. Fila de 4 columnas
    // planas (no colMarkup — el diseño final de dev/proto-dash.html las puso
    // como 4 pares, no 2+2) — diseño visual portado desde dev/proto-styles.css
    // (27 ago, versión final del usuario) a este CSS con selectores
    // prefijados. gps_signal/alertas_generales quedan en "Cargando..." — su
    // conteo (buckets GPS, events.php por categoría) no está conectado
    // todavía, no se fabrica dato de ejemplo en el plugin real.
    // -----------------------------------------------------------------------
    // Bloque "Exportar Reporte / Generar Golden Report" bajo el logo.
    // PLACEHOLDER VISUAL — sin lógica (decisión 3 sep). Comunica lo que
    // viene (FR-0005: reportes visuales propios). Los controles se ven pero
    // no hacen nada; se marcan con --beta como las tarjetas de alerta sin
    // conectar.
    exportBlockMarkup: function () {
        return {
            cls: 'promatic_dashboard_enhancer-export-block',
            cn: [
                {
                    cls: 'promatic_dashboard_enhancer-export-card promatic_dashboard_enhancer-export-card--beta',
                    cn: [
                        { cls: 'promatic_dashboard_enhancer-export-card__title', html: l('Exportar Reporte') },
                        { cls: 'promatic_dashboard_enhancer-export-card__control', html: l('Seleccionar') + ' ▾' }
                    ]
                },
                {
                    cls: 'promatic_dashboard_enhancer-export-card promatic_dashboard_enhancer-export-card--beta',
                    cn: [
                        { cls: 'promatic_dashboard_enhancer-export-card__title', html: l('Generar Golden Report') },
                        { cls: 'promatic_dashboard_enhancer-export-card__control', html: '▾' }
                    ]
                }
            ]
        };
    },

    // Layout de 4 columnas (rediseño 3 sep, idea-rediseño-layout.jpg):
    //  - Col izq FIJA: reloj (grande) + Alertas Generales (vertical).
    //  - Col centro (2-3) FLEX: Sin Señal GPS (buckets horizontales) arriba,
    //    luego Estado de Flota + Top KM lado a lado, luego mapa hotspots ancho.
    //  - Col der FIJA: logo (sin header) + bloque export (placeholder).
    //  - Buscador: OCULTO — cardMarkup('buscador') se conserva pero no se
    //    monta (vuelve con FR-0006, asistente IA).
    // Para LOC/LOP: col izq y la posición de Sin Señal GPS quedan fijas;
    // solo cambian las columnas del centro (buildLopShell se adapta aparte).
    buildRacShell: function () {
        var colLeft = {
            cls: 'promatic_dashboard_enhancer-shell-col--fixed-left',
            cn: [
                this.cardMarkup('reloj', { title: l('Hora Oficial'), noFooter: true }),
                this.cardMarkup('alertas_generales', {
                    title: l('Alertas Generales'),
                    hint: l('Accidentes: eventos de los últimos 30 días. Requiere mantención: recordatorios por vehículo configurados en PILOT. Las categorías "beta" aún no están conectadas.'),
                    footerLabel: l('Abrir alertas'),
                    skeleton: 'stats'
                })
            ]
        };

        var center = {
            cls: 'promatic_dashboard_enhancer-shell-center',
            cn: [
                this.cardMarkup('gps_signal', {
                    title: l('Sin Señal GPS'),
                    hint: l('Vehículos sin conexión al servidor, agrupados por el tiempo desde su última señal recibida. Se actualiza en vivo con el árbol Online.'),
                    footerLabel: l('Abrir alertas de señal'),
                    skeleton: 'chips'
                }),
                {
                    cls: 'promatic_dashboard_enhancer-shell-center-row',
                    cn: [
                        this.cardMarkup('flota', {
                            title: l('Estado de Flota'),
                            hint: l('Porcentajes sobre el total de vehículos del árbol Online. Se actualiza en vivo.'),
                            footerLabel: l('Abrir árbol de flota'),
                            skeleton: 'donut'
                        }),
                        this.cardMarkup('top5km', {
                            title: l('Vehículos con Kilometraje en Exceso'),
                            hint: l('Kilómetros por vehículo en el período configurado (por defecto 7 días). Fuente: /api/v3/vehicles/trips, con respaldo al reporte de kilometraje.'),
                            footerLabel: l('Abrir reporte de kilometraje'),
                            skeleton: 'ranking'
                        })
                    ]
                },
                this.cardMarkup('hotspots', {
                    title: l('Hotspots de desconexión'), meta: 'type=15',
                    footerLabel: l('Abrir mapa de desconexión'),
                    skeleton: 'map'
                })
            ]
        };

        var colRight = {
            cls: 'promatic_dashboard_enhancer-shell-col--fixed-right',
            cn: [
                this.cardMarkup('logo', { noFooter: true }),
                this.exportBlockMarkup()
            ]
        };

        var shell = [
            { cls: 'promatic_dashboard_enhancer-shell-4col', cn: [colLeft, center, colRight] },
            this.controlsBarMarkup()
        ];

        return Ext.create('Ext.Component', {
            cls: 'promatic_dashboard_enhancer-rac-shell',
            html: Ext.DomHelper.markup(shell)
        });
    },

    // Barra de controles del pie del dashboard:
    //  - Slider de alcance: 2 posiciones explícitas — "Selección Principal"
    //    (izquierda) sigue los checkboxes del panel "Principal" de PILOT;
    //    "Toda la flota" (derecha) ignora la selección. Es un slider y no un
    //    botón toggle a propósito: el estado se lee de la posición del thumb,
    //    no hay ambigüedad de "¿avanza o retrocede al hacer click?". Override
    //    en localStorage, sin re-publicar.
    //  - Actualizar widgets: re-dispara todos los widgets sin recargar y
    //    sella la hora en la barra de resumen ("actualizado HH:MM:SS").
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

    // Fija el alcance a un modo explícito ('pilot-selection' | 'all') según
    // el lado del slider elegido. 'pilot-selection' limpia el override (es el
    // default de config); 'all' lo escribe.
    setScopeMode: function (mode) {
        if (mode === this.effectiveFleetScope()) { return; }
        this.setScopeOverride(mode === 'all' ? 'all' : null);
        this.syncScopeSlider();
        this.refreshAllWidgets();
    },

    // Re-corre todos los widgets con datos en vivo — no toca reloj/logo.
    // Sella la hora del último refresco manual (la muestra la barra de
    // resumen); antes ese texto se re-pintaba en cada datachanged del árbol
    // y parecía un reloj.
    refreshAllWidgets: function () {
        this._lastManualRefresh = new Date();
        this.refreshFleetStore();
        this.loadTop5KmData();
        this.loadAlertasGenerales();
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
            }
        });

        this.syncScopeSlider();
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
                    title: l('Vehículos con Kilometraje en Exceso'), meta: 'rt=4',
                    footerLabel: l('Abrir reporte de kilometraje')
                })
            ]),
            this.rowMarkup([
                this.cardMarkup('hotspots', {
                    title: l('Hotspots de desconexión'), meta: 'type=15',
                    footerLabel: l('Abrir mapa de desconexión')
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

    // Diccionario de errores (catálogo completo en spec/datos.md): cada
    // punto de falla conocido de un widget emite un código corto y estable
    // (ej. "KM-TIMEOUT") — permite que el usuario reporte "vi el código X"
    // sin necesitar abrir la consola del navegador. Sin backend de logging
    // por ahora, solo trazabilidad local.
    widgetErrorCode: function (base, err, context) {
        var code = base + (err && err.name === 'AbortError' ? '-TIMEOUT' : '-FALLO');
        console.error('[promatic_dashboard_enhancer] ' + code + ':', err, context || '');
        return code;
    },

    getOnlineTree: function () {
        return (window.skeleton && skeleton.navigation && skeleton.navigation.online &&
            skeleton.navigation.online.online_tree) || null;
    },

    // Filtro opcional de alcance de flota — resuelve cuentas donde
    // Alcance del dashboard, operable desde el slider del pie:
    // 'pilot-selection' = sigue la selección con checkbox del panel "Principal";
    // 'all' = flota completa del árbol Online.
    // (El filtro por lista de agent_ids en localStorage — dev override de
    // NOC-007 — se retiró el 1 sep: el slider ya da control explícito, y la
    // lista de 45 ids del demo pisaba el modo "toda la flota".)
    SCOPE_OVERRIDE_STORAGE_KEY: 'promatic_dashboard_enhancer_scope_override',

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

    // Alcance efectivo: el slider (localStorage) gana sobre config.fleet.scope.
    effectiveFleetScope: function () {
        var override = this.getScopeOverride();
        if (override === 'all' || override === 'pilot-selection') {
            return override;
        }
        var fleetCfg = (this.config && this.config.fleet) || this.DEFAULT_CONFIG.fleet;
        return fleetCfg.scope || 'all';
    },

    // agent_ids marcados con checkbox en el panel "Principal" de PILOT
    // (online_tree.getChecked()), filtrados a hojas reales — un nodo de
    // carpeta/modelo no tiene 'agentid'. Devuelve null si getChecked no está
    // disponible o no hay nada marcado (→ el caller cae a la flota completa).
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

    // ¿Hay carpetas marcadas (checked) en el árbol pero colapsadas, de modo
    // que sus vehículos hijos NO están materializados como checked en el
    // store? El checkbox de una carpeta en el árbol de PILOT solo propaga
    // checked=true a los registros hijos al EXPANDIR la carpeta — con la
    // carpeta cerrada, getChecked()/cascadeBy ven la carpeta marcada pero
    // ninguna hoja. Confirmado en DEMO_CLIENT (1 sep). Ver ADR-014 y FR-0004.
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

    // FR-0004: expandir las carpetas marcadas pero colapsadas del árbol
    // "Principal". El checkbox de una carpeta solo propaga checked=true a los
    // vehículos hijos al EXPANDIR la carpeta, así que forzamos la expansión de
    // esas ramas. expand() es async y dispara 'checkchange' en cada hijo al
    // materializarse el checked → el listener con debounce re-renderiza solo.
    // Se dejan expandidas a propósito (el usuario ve qué entró al dashboard);
    // los checkboxes no se tocan. Devuelve true si expandió al menos una.
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
        // Red de seguridad: si expand() no acaba disparando 'checkchange'
        // (hijos ya checked en el modelo, solo la carpeta estaba colapsada),
        // el listener con debounce no re-renderiza. Un re-render diferido
        // único cubre ese caso. _selectionExpandRetry evita un bucle.
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

        // Alcance: 'pilot-selection' filtra a los vehículos marcados en el
        // panel "Principal"; 'all' devuelve la flota completa del árbol Online.
        this._selectionEmpty = false;
        this._selectionCollapsed = false;
        var scope = null;
        if (this.effectiveFleetScope() === 'pilot-selection' && onlineTree &&
            typeof onlineTree.getChecked === 'function') {
            scope = this.getPilotSelectionIds(onlineTree);
            // getChecked() disponible pero ninguna hoja marcada: puede ser
            // (a) el usuario no seleccionó nada, o (b) marcó carpetas pero
            // las tiene colapsadas (PILOT no materializa los hijos hasta
            // expandir). Distinguir para dar el mensaje correcto.
            if (!scope) {
                this._selectionEmpty = true;
                // FR-0004: si hay carpetas marcadas pero colapsadas, PILOT
                // no materializó sus vehículos como checked. Forzar la
                // expansión de esas ramas; expand() dispara 'checkchange'
                // en los hijos → el listener con debounce re-renderiza. En
                // esta pasada mostramos un mensaje transitorio.
                if (this.hasCollapsedCheckedFolders(onlineTree)) {
                    this._selectionCollapsed = true;
                    this._selectionExpanding = this.expandCheckedFolders(onlineTree);
                } else {
                    this._selectionCollapsed = false;
                    this._selectionExpanding = false;
                }
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

    // Vehículos del alcance que se movieron en los últimos `days` días —
    // filtro por `last_event.last_move` (timestamp del último movimiento),
    // client-side, sin llamada. Un vehículo sin movimiento en la ventana
    // tiene 0 km, así que dejarlo fuera de la consulta a reports.php no
    // cambia el ranking pero corta el payload (crítico cuando online_tree
    // tiene la flota LOC completa — ver NOC-007 y la exploración del 28 ago:
    // no hay endpoint de km por vehículo pre-calculado).
    // Devuelve los agent_ids ordenados por movimiento más reciente primero,
    // para que el caller pueda cortar a un tope (config top5km.activeVehicleCap)
    // quedándose con los más activos.
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

    // Poll acotado (40 x 500ms = 20s) hasta que el store de online_tree tenga
    // filas, después bindea los listeners UNA sola vez (guard _fleetBound) y
    // hace el primer refresh. NO usa withFleetVehicleIds: su rama de "lista
    // vacía" se re-suscribe a 'datachanged' en cada disparo, y con el árbol
    // Online actualizándose seguido eso se volvía un loop caliente.
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

        // Re-renderizar cuando el usuario marca/desmarca vehículos en el
        // panel "Principal". checkchange se dispara una vez por hoja al
        // cascadear una carpeta — debounce para coalescer la ráfaga. El
        // handler chequea el scope efectivo en cada disparo, así el toggle
        // del pie del dashboard funciona sin re-bindear.
        var me = this;
        var onlineTree = this.getOnlineTree();
        if (!this._selectionBound && onlineTree && typeof onlineTree.on === 'function') {
            onlineTree.on('checkchange', function (node) {
                if (me.effectiveFleetScope() !== 'pilot-selection') { return; }
                // FR-0004: si marcaron una carpeta colapsada, PILOT no
                // propaga checked a los vehículos hijos hasta expandirla.
                // Forzar la expansión acá mismo — checkchange SÍ llega para
                // el nodo carpeta aunque no cascadee a los hijos ocultos.
                if (node && node.get && node.get('checked') && !node.get('agentid') &&
                    node.isExpandable && node.isExpandable() && !node.isExpanded()) {
                    try { node.expand(); } catch (err) { me.widgetErrorCode('FLEET-EXPAND', err); }
                }
                if (me._selectionTimer) { return; }
                me._selectionTimer = Ext.defer(function () {
                    me._selectionTimer = null;
                    me.refreshFleetStore();
                    me.loadTop5KmData();
                }, 600);
            });
            this._selectionBound = true;
        }

        this.refreshFleetStore();
    },

    // Segundos desde el último event recibido de un vehículo — proxy de
    // "hace cuánto está sin señal". last_event.unixtimestamp es la marca más
    // reciente que el device mandó (posición/velocidad); para un vehículo
    // is_server_online=false equivale a "cuándo se quedó mudo". Aproximación
    // razonable para buckets de 24h; la fuente exacta por evento de
    // desconexión sería events.php type=15 (llamada HTTP aparte). Devuelve
    // null si no hay timestamp usable.
    secondsSinceLastEvent: function (record) {
        var le = record.get('last_event') || (record.data && record.data.last_event);
        var ts = le && Number(le.unixtimestamp);
        if (!ts || !isFinite(ts)) {
            return null;
        }
        return Math.max(0, Math.floor(Date.now() / 1000) - ts);
    },

    // Único punto que recorre online_tree en cada 'datachanged'/'update' —
    // alimenta la barra de resumen, la card "Flota" (id 'flota') y la card
    // "Señal GPS" (id 'gps_signal') — mismo recorrido, sin llamada HTTP.
    // 'flota'/'gps_signal' son ids compartidos por el shell RAC y el LOP;
    // solo un shell está montado a la vez.
    // Throttle: el árbol Online dispara 'datachanged' cientos de veces por
    // segundo con flota grande (cada ping de cada vehículo). Coalescemos en
    // una corrida cada 2s como mucho — leading edge (la primera pinta al
    // toque) + trailing (una más al final de la ráfaga).
    FLEET_REFRESH_MIN_GAP_MS: 2000,

    refreshFleetStore: function () {
        var me = this;

        if (this._fleetRefreshTimer) {
            return; // ya hay una corrida agendada dentro de la ventana
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
            this.updateCardBody('flota', msgSel);
            this.updateCardBody('gps_signal', msgSel);
            return;
        }

        var total = 0;
        var moving = 0, parked = 0, offlineCount = 0;
        var gps24 = 0, gps48 = 0, gpsMore = 0;
        var DAY = 86400;

        for (var i = 0; i < records.length; i++) {
            var r = records[i];

            if (!r.get('agentid')) {
                continue; // nodo de grupo/carpeta, no un vehículo
            }

            var isOnline = !!r.get('is_server_online');
            var statusText = r.get('status') || '';
            total++;

            if (!isOnline) {
                offlineCount++;
                var age = this.secondsSinceLastEvent(r);
                if (age !== null && age < DAY) {
                    gps24++;
                } else if (age !== null && age < 2 * DAY) {
                    gps48++;
                } else {
                    // age >= 48h, o sin timestamp usable — al bucket más
                    // severo (llevamos ≥48h sin saber nada del device).
                    gpsMore++;
                }
            } else if (statusText.indexOf('movimiento') !== -1) {
                // "En movimientos X km/h" vs. "Estacionamiento..." — texto
                // real confirmado en DEMO_CLIENT, no un campo separado.
                moving++;
            } else {
                parked++;
            }
        }

        // Log solo cuando los números cambian — con flota estable, silencio.
        var sig = total + '/' + offlineCount + '/' + moving + '/' + parked +
            '/' + gps24 + '/' + gps48 + '/' + gpsMore;
        if (sig !== this._fleetSig) {
            this._fleetSig = sig;
            console.log('[promatic_dashboard_enhancer] flota: total=' + total +
                ' online=' + (total - offlineCount) + ' offline=' + offlineCount +
                ' | señal GPS <24h=' + gps24 + ' 24-48h=' + gps48 + ' >48h/sin dato=' + gpsMore);
        }

        this.updateSummary(total, total - offlineCount);
        this.updateFlotaLopCard(total, moving, parked, offlineCount);
        this.updateGpsSignalCard(gps24, gps48, gpsMore);
    },

    // Reloj "Hora exacta Chile" — puro cliente, sin API. Se pinta la card una
    // vez y después se actualiza solo el nodo de la hora cada segundo (no
    // updateCardBody, que re-parsea el HTML completo). El setInterval no se
    // limpia: el módulo vive toda la sesión (es un nav tab), igual que el
    // resto del módulo no tiene teardown.
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

        // El título "Hora Oficial" ya lo pone la cabecera de la card
        // (cardMarkup). El cuerpo muestra solo la hora — antes repetía el
        // rótulo y quedaba "Hora Oficial / Hora exacta Chile / HH:MM:SS".
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
                { tag: 'img', src: this.getModuleBaseUrl() + 'img/dashboard-enhancer-resized-small.jpg', alt: 'Dashboard Enhancer' }
            ]
        }));
    },

    // Alertas Generales (card 'alertas_generales') — 2 categorías:
    //  - Accidentes: events.php type=29, ventana de 30 días (REF-001 §11.3).
    //  - Requiere mantención: dashboard.php cmd=ptm — recordatorios; contamos
    //    los ligados a vehículo (link_type != 'drivers'). El shape de ptm no
    //    está confirmado en DEMO_CLIENT (en la cuenta de pruebas solo había un
    //    recordatorio de licencia de conductor) — el console.log del raw es
    //    para verificar. Cualquier categoría que falle muestra "N/D", no
    //    tumba la otra.
    // "En taller" se retiró (chip decorativo sin fuente, pedido del Dev de
    // Pilot 25 ago).
    loadAlertasGenerales: function () {
        var me = this;

        this.withFleetVehicleIds(function (vehIds) {
            var csv = vehIds.join(',');
            var stop = new Date();
            var start = new Date();
            start.setDate(start.getDate() - 30);
            var fmt = function (d) { return d.toISOString().slice(0, 10); };

            var accidentes = me.fetchEventCount(csv, 29, fmt(start), fmt(stop))
                .catch(function (err) { me.widgetErrorCode('ALERT-ACC', err); return null; });

            var mantencion = me.fetchDashboardCmd('ptm', csv, 8000)
                .then(function (data) {
                    console.log('[promatic_dashboard_enhancer] ptm raw:', data);
                    var items = (data && (data.data || data.items || data.list)) || [];
                    if (!Array.isArray(items)) { items = []; }
                    var n = 0;
                    for (var i = 0; i < items.length; i++) {
                        if (items[i] && items[i].link_type !== 'drivers') { n++; }
                    }
                    return n;
                })
                .catch(function (err) { me.widgetErrorCode('ALERT-PTM', err); return null; });

            Promise.all([accidentes, mantencion]).then(function (r) {
                console.log('[promatic_dashboard_enhancer] alertas generales: accidentes=' +
                    r[0] + ' requiere_mantencion=' + r[1]);
                me.renderAlertasGenerales(r[0], r[1]);
            });
        });
    },

    renderAlertasGenerales: function (accidentes, mantencion) {
        var svgAccidente =
            '<svg viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.5" ' +
            'stroke-linecap="round" stroke-linejoin="round">' +
            '<path d="M9 2 L16.5 15.5 H1.5 Z" /><line x1="9" y1="7" x2="9" y2="11" />' +
            '<circle cx="9" cy="13.2" r="0.9" fill="currentColor" stroke="none" /></svg>';
        var svgMantencion =
            '<svg viewBox="0 0 26 26" fill="currentColor"><path d="M1.313 0L0 1.313l2.313 4l1.5-.22' +
            'l9.156 9.157l-.781.75c-.4.4-.4 1.006 0 1.406l.406.407c.4.4 1.012.4 1.312 0L15.094 18' +
            'c-.1.6 0 1.313.5 1.813L21 25.188c1.1 1.1 2.9 1.1 4 0c1.3-1.2 1.288-2.994.188-4.094' +
            'l-5.375-5.407c-.5-.5-1.213-.7-1.813-.5L16.687 14c.3-.4.3-1.012 0-1.313l-.375-.374' +
            'a.974.974 0 0 0-1.406 0l-.656.656l-9.156-9.156l.218-1.5l-4-2.313zm19.5.031C18.84-.133 ' +
            '16.224 1.175 15 2.312c-1.506 1.506-1.26 3.475-.063 5.376l-2.124 2.125l1.5 1.687c.8-.7 ' +
            '1.98-.7 2.78 0l.407.406l.094.094l.875-.875c1.808 1.063 3.69 1.216 5.125-.219c1.4-1.3 ' +
            '2.918-4.506 2.218-6.406L23 7.406c-.4.4-1.006.4-1.406 0L18.687 4.5a.974.974 0 0 1 0-1.406' +
            'L21.595.188c-.25-.088-.5-.133-.782-.157m-11 12.469l-3.626 3.625A5.3 5.3 0 0 0 5 16' +
            'c-2.8 0-5 2.2-5 5s2.2 5 5 5s5-2.2 5-5c0-.513-.081-1.006-.219-1.469l2.125-2.125l-.312-.406' +
            'c-.8-.8-.794-2.012-.094-2.813L9.812 12.5z" /></svg>';

        // Íconos de las categorías beta (aún sin datos conectados).
        // Combustible y GPS manual: SVGs oficiales del proyecto (dev/icons/,
        // usan currentColor). Ralentí: versión simplificada de icon-ralenti.svg
        // (el original es un reloj con dígitos, demasiado pesado para inline).
        // Territorio: genérico (no hay ícono oficial todavía).
        var svgRalenti =
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" ' +
            'stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9" />' +
            '<path d="M12 7v5l3 2" /></svg>';
        var svgCombustible =
            '<svg viewBox="0 0 24 24"><path fill="currentColor" fill-rule="evenodd" ' +
            'd="M2 .75H.75v22.5h14.5v-4.006a5.25 5.25 0 0 0 5-5.244V7.25H23v-2.5h-2.45A2.75 2.75 0 0 1 23 3.25V.75' +
            'A5.25 5.25 0 0 0 17.75 6v8a2.75 2.75 0 0 1-2.5 2.739V.75zM3.25 8.5V3.25h9.5V8.5z" clip-rule="evenodd"/></svg>';
        var svgGpsManual =
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">' +
            '<path stroke-linecap="round" d="m22 8l-3-3m0 0l-3-3m3 3l-3 3m3-3l3-3"/>' +
            '<path d="M9 10.03A3.515 3.515 0 0 1 13.97 15"/>' +
            '<path stroke-linejoin="round" d="M4.853 19.147c3.196 3.196 8.06 3.707 11.789 1.533c.886-.517 1.33-.776 1.357-1.302' +
            's-.471-.89-1.468-1.618c-1.848-1.35-3.667-3-5.48-4.812C9.24 11.136 7.59 9.317 6.24 7.47c-.728-.997-1.092-1.495-1.618-1.468' +
            's-.785.47-1.302 1.357c-2.174 3.73-1.663 8.593 1.533 11.79Z"/></svg>';
        var svgTerritorio =
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" ' +
            'stroke-linecap="round" stroke-linejoin="round"><path d="M3 6l6-3 6 3 6-3v15l-6 3-6-3-6 3z" />' +
            '<path d="M9 3v15M15 6v15" /></svg>';

        // count: número (conectada), null/undefined (falló → "N/D"),
        // o beta:true (categoría futura → badge "beta", sin número).
        var card = function (bg, title, count, iconSvg, titleAttr, isBeta) {
            var body;
            if (isBeta) {
                body = { cls: 'promatic_dashboard_enhancer-stat-card__count promatic_dashboard_enhancer-stat-card__count--beta', html: l('beta') };
            } else if (count === null || count === undefined) {
                body = { cls: 'promatic_dashboard_enhancer-stat-card__count', html: l('N/D') };
            } else {
                body = { cls: 'promatic_dashboard_enhancer-stat-card__count', html: String(count) };
            }
            return {
                tag: 'a', href: '#', style: 'background:' + bg, title: titleAttr,
                cls: 'promatic_dashboard_enhancer-stat-card' + (isBeta ? ' promatic_dashboard_enhancer-stat-card--beta' : ''),
                cn: [
                    { tag: 'span', cls: 'promatic_dashboard_enhancer-stat-card__icon', html: iconSvg },
                    { cls: 'promatic_dashboard_enhancer-stat-card__title', html: title },
                    body
                ]
            };
        };

        // Si alguna categoría CONECTADA tiene incidencias (> 0), la card entera
        // vira de azul a naranja de alerta. Las beta y las que fallaron (N/D)
        // no cuentan para esto.
        var hasAlert = (typeof accidentes === 'number' && accidentes > 0) ||
                       (typeof mantencion === 'number' && mantencion > 0);
        var gridCls = 'promatic_dashboard_enhancer-stat-card-grid' +
            (hasAlert ? ' promatic_dashboard_enhancer-stat-card-grid--alert' : '');

        this.updateCardBody('alertas_generales', Ext.DomHelper.markup({
            cls: gridCls,
            cn: [
                card('var(--g6)', l('Accidentes'), accidentes, svgAccidente,
                    l('Accidentes — events.php type=29, últimos 30 días')),
                card('var(--g7)', l('Requiere mantención'), mantencion, svgMantencion,
                    l('Recordatorios de mantención de vehículo (ptm)')),
                card('var(--g6)', l('Ralentí excesivo'), null, svgRalenti,
                    l('Ralentí acumulado sobre umbral — pendiente de conexión'), true),
                card('var(--g7)', l('Manipulación de combustible'), null, svgCombustible,
                    l('Drenaje/carga anómala de estanque — pendiente de conexión'), true),
                card('var(--g6)', l('GPS desconectado manual'), null, svgGpsManual,
                    l('Desconexión intencional del equipo — pendiente de conexión'), true),
                card('var(--g7)', l('Salida de territorio nacional'), null, svgTerritorio,
                    l('Vehículo cruza la frontera — pendiente de conexión'), true)
            ]
        }));
    },

    // Hotspots de desconexión (card 'hotspots') — heatmap sobre un
    // MapContainer PROPIO (instancia nueva, NO se reusa window.mapContainer:
    // esa es solo para features dentro de los tabs Online/History — ver
    // spec/api.md "Crear un mapa propio dentro de un panel de la extensión").
    // Datos: events.php type=15 ("No connection"), ventana 30 días, cada item
    // trae lat/lon. Se agrega por celda de ~0.01° y se pasa a setHeatmap.
    getMapContainerClass: function () {
        return window.MapContainer ||
            (window.Pilot && Pilot.utils && Pilot.utils.MapContainer) || null;
    },

    loadHotspots: function () {
        var me = this;

        this.withFleetVehicleIds(function (vehIds) {
            if (!me.getMapContainerClass()) {
                me.updateCardBody('hotspots', l('El mapa no está disponible en este runtime.'));
                return;
            }

            var csv = vehIds.join(',');
            var stop = new Date();
            var start = new Date();
            start.setDate(start.getDate() - 30);
            var fmt = function (d) { return d.toISOString().slice(0, 10); };

            var qs = 'cmd=search&veh=' + encodeURIComponent(csv) +
                '&type=15&date_start=' + fmt(start) + '&date_stop=' + fmt(stop) +
                '&limit=500&page=1&start=0';

            fetch('/backend/ax/mod/events.php?' + qs, { credentials: 'include' })
                .then(function (resp) {
                    if (!resp.ok) { throw new Error('HTTP ' + resp.status); }
                    return resp.json();
                })
                .then(function (data) {
                    me.renderHotspots((data && data.items) || []);
                })
                .catch(function (err) {
                    var code = me.widgetErrorCode('HOTSPOTS', err);
                    me.updateCardBody('hotspots',
                        l('No se pudo cargar el mapa de desconexión.') + ' (' + code + ')');
                });
        });
    },

    renderHotspots: function (items) {
        var buckets = {};
        var withCoords = 0;

        for (var i = 0; i < items.length; i++) {
            var lat = Number(items[i].lat);
            var lon = Number(items[i].lon);
            if (!lat || !lon || !isFinite(lat) || !isFinite(lon)) {
                continue; // event sin ubicación
            }
            withCoords++;
            var key = lat.toFixed(2) + ',' + lon.toFixed(2);
            if (!buckets[key]) {
                buckets[key] = { lat: lat, lng: lon, count: 0 };
            }
            buckets[key].count++;
        }

        var points = [];
        for (var k in buckets) {
            if (buckets.hasOwnProperty(k)) {
                points.push(buckets[k]);
            }
        }

        console.log('[promatic_dashboard_enhancer] hotspots: ' + items.length +
            ' eventos type=15, ' + withCoords + ' con coords, ' + points.length + ' celdas');

        if (points.length === 0) {
            this.updateCardBody('hotspots',
                l('Sin desconexiones con ubicación en los últimos 30 días.'));
            return;
        }

        this.updateCardBody('hotspots', Ext.DomHelper.markup({
            id: 'promatic_dashboard_enhancer-hotspots-map',
            cls: 'promatic_dashboard_enhancer-map-el'
        }));

        var me = this;
        var MC = this.getMapContainerClass();

        // defer: el div del mapa tiene que estar en el DOM con dimensiones
        // antes de que Leaflet lo tome (si no, mide 0x0 y no dibuja).
        Ext.defer(function () {
            try {
                var mc = new MC('promatic_dashboard_enhancer_hotspots');
                mc.init(points[0].lat, points[0].lng, 6,
                    'promatic_dashboard_enhancer-hotspots-map', { withControls: true });

                if (typeof mc.setHeatmap === 'function') {
                    mc.setHeatmap(points, true, l('Desconexiones'));
                }
                // Leaflet a veces necesita recalcular tamaño tras montarse
                // dentro de un contenedor flex que terminó de dimensionar.
                Ext.defer(function () {
                    var map = mc.getMap ? mc.getMap() : mc.map;
                    if (map && map.invalidateSize) { map.invalidateSize(); }
                }, 400);

                me._hotspotsMap = mc;
            } catch (err) {
                me.widgetErrorCode('HOTSPOTS-MAP', err);
                me.updateCardBody('hotspots', l('No se pudo inicializar el mapa de desconexión.'));
            }
        }, 300, this);
    },

    updateGpsSignalCard: function (b24, b48, bMore) {
        // 3 buckets en fila horizontal (rediseño 3 sep). El chip "Más de 48h"
        // (--red) es el único que pulsa (@keyframes ...-alert-pulse).
        var chip = function (mod, label, count, title) {
            return {
                tag: 'a', href: '#',
                cls: 'promatic_dashboard_enhancer-signal-chip promatic_dashboard_enhancer-signal-chip--' + mod,
                title: title,
                cn: [
                    { tag: 'span', cls: 'promatic_dashboard_enhancer-signal-chip__label', html: label },
                    { tag: 'span', cls: 'promatic_dashboard_enhancer-signal-chip__badge', html: String(count) }
                ]
            };
        };

        this.updateCardBody('gps_signal', Ext.DomHelper.markup({
            cls: 'promatic_dashboard_enhancer-signal-track',
            cn: [
                chip('yellow', l('Menos de 24h'), b24, l('Vehículos desconectados hace menos de 24h')),
                chip('orange', l('Entre 24 y 48h'), b48, l('Vehículos desconectados entre 24 y 48h')),
                chip('red', l('Más de 48h'), bMore, l('Vehículos desconectados hace más de 48h o sin dato reciente'))
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
        }));
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

    // -----------------------------------------------------------------------
    // Fetch compartido — reports.php (get_report / report_type) y analytics/*
    // Todo vía fetch() nativo, nunca Ext.Ajax.request: dentro del proxy
    // /store/<extension>/ de una extensión, Ext.Ajax reescribe rutas
    // relativas y devuelve 404 (confirmado en runtime real, ver spec/api.md).
    // -----------------------------------------------------------------------

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

    // -----------------------------------------------------------------------
    // API v3 — /api/v3/vehicles/trips (x-legacy cmd:distance). 1 request por
    // vehículo. URL RELATIVA al host (same-origin) — un host absoluto se
    // bloquea por CORS (verificado 2026-09-03, ver spec/api.md). Devuelve
    // { code, msg, data:[tramos] }; cada tramo trae gps (km por GPS) y can
    // (km por odómetro CAN, a veces 0). data:[] si el vehículo no se movió.
    // -----------------------------------------------------------------------

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

    // Suma el km de todos los tramos de una respuesta de fetchVehicleTripsV3.
    // kmField: 'gps' (default, primario) | 'can'. data ausente / [] → 0.
    sumTripsKm: function (tripsResponse, kmField) {
        var field = kmField || 'gps';
        var tramos = (tripsResponse && tripsResponse.data) || [];
        var km = 0;
        for (var i = 0; i < tramos.length; i++) {
            km += Number(tramos[i][field]) || 0;
        }
        return Math.round(km * 10) / 10;
    },

    // startIso/stopIso opcionales (formato "YYYY-MM-DDTHH:MM:SS"). Sin ellos:
    // día actual con today=true (comportamiento original). Con ellos: ventana
    // real, today='' — necesario para el Top 5 KM (ventana de N días).
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

    // Espera (poll acotado, 40 x 500ms = 20s) a que online_tree tenga
    // vehículos y devuelve la lista de agent_ids — patrón compartido por
    // todos los widgets que dependen de la flota. Poll, NO re-suscripción a
    // 'datachanged': el árbol Online se actualiza seguido y re-suscribir en
    // cada disparo se volvía un loop caliente (28 ago).
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
            // FR-0004: si estamos siguiendo la selección de PILOT y hay
            // carpetas marcadas pero colapsadas, intentar expandirlas en
            // cada reintento (barato, con guard interno) — así si el usuario
            // marca la carpeta mientras el waiter gira, se abre sola.
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

    // Card "Top 5 · Vehículos con más KM".
    //
    // Fuente primaria: analytics/vehicles.php cmd=get_main_data → ratings.data
    // (km por vehículo en UNA llamada, sin reports.php ni riesgo de timeout —
    // NOC-007). Fallback automático: reports.php report_type=4 (camino previo).
    //
    // En ambos casos se pre-filtra a los vehículos con movimiento reciente
    // (config top5km.windowDays) y se corta a un tope (config
    // top5km.activeVehicleCap) para no disparar el job async + WebSocket de
    // analytics/vehicles.php en flotas grandes (NOC-003). Un vehículo sin
    // movimiento tiene 0 km, así que el filtro no cambia el ranking.
    loadTop5KmData: function () {
        var me = this;
        var cfg = (me.config && me.config.top5km) || me.DEFAULT_CONFIG.top5km;
        var days = cfg.windowDays || 7;
        var cap = cfg.activeVehicleCap || 300;
        var count = cfg.count || 5;

        this.withFleetVehicleIds(function () {
            var onlineTree = me.getOnlineTree();
            var vehIds = me.getRecentlyActiveIds(onlineTree, days);
            var scopeTotal = me.getFleetVehicleIds(onlineTree).length;
            var capped = false;
            if (vehIds.length > cap) {
                vehIds = vehIds.slice(0, cap);
                capped = true;
            }

            console.log('[promatic_dashboard_enhancer] Top KM: ' + vehIds.length +
                ' vehículos con movimiento en ' + days + 'd (de ' + scopeTotal + ' en alcance)' +
                (capped ? ' [cortado al tope de ' + cap + ']' : '') + ' — top ' + count);

            if (vehIds.length === 0) {
                var msg = l('Ningún vehículo con recorrido reciente.');
                if (me._selectionExpanding) {
                    msg = l('Cargando vehículos de las carpetas seleccionadas…');
                } else if (me._selectionCollapsed) {
                    msg = l('Expande en el panel "Principal" las carpetas que marcaste para incluir sus vehículos.');
                } else if (me._selectionEmpty) {
                    msg = l('Selecciona vehículos en el panel "Principal" para ver el ranking.');
                }
                me.updateCardBody('top5km', msg);
                return;
            }

            // Mapa nombre→agentid del árbol Online — la rama fallback
            // (reports.php) agrupa por nombre de vehículo y no trae el id,
            // así se recupera para el link a Informes (best-effort).
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

            var runReports = function () {
                return me.fetchReportType(4, csv, startDate, stopDate, 20000)
                    .then(function (report) {
                        me.renderTop5Km(me.parseReportType4(report, nameToId), days, startDate, stopDate, count);
                        console.log('[promatic_dashboard_enhancer] Top KM servido por: reports');
                    });
            };
            var runRatings = function () {
                return me.fetchAnalyticsMainData(csv, 15000,
                    startDate.toISOString().slice(0, 19), stopDate.toISOString().slice(0, 19))
                    .then(function (mainData) {
                        me.renderTop5Km(me.parseRatingsTop5(mainData), days, startDate, stopDate, count);
                        console.log('[promatic_dashboard_enhancer] Top KM servido por: ratings');
                    });
            };
            var runTripsV3 = function () {
                var tripIds = vehIds.slice(0, cfg.tripsMaxVehicles || 100);
                return me._top5FromTripsV3(tripIds, startDate, stopDate, nameToId, cfg)
                    .then(function (ranked) {
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

    // Rama "trips-v3" del Top KM. Consulta /api/v3/vehicles/trips por cada
    // vehículo candidato, en lotes de cfg.tripsBatchSize (concurrentes; los
    // lotes van en serie). Un vehículo que falla cuenta 0 km y no aborta.
    // Devuelve ranked = [{name, km, id}] ordenado desc — id = agentid, name
    // del árbol si se conoce, si no el agent_id como string.
    _top5FromTripsV3: function (vehIds, startDate, stopDate, nameToId, cfg) {
        var me = this;
        var batchSize = cfg.tripsBatchSize || 4;
        var kmField = cfg.kmField || 'gps';
        var tsUnix = Math.floor(startDate.getTime() / 1000);
        var teUnix = Math.floor(stopDate.getTime() / 1000);
        var idToName = {};
        for (var nm in nameToId) {
            if (nameToId.hasOwnProperty(nm)) { idToName[Number(nameToId[nm])] = nm; }
        }

        var results = [];
        var queue = vehIds.slice();
        var PromiseImpl = (typeof Ext !== 'undefined' && Ext.Promise) ? Ext.Promise : Promise;

        function runBatch() {
            if (queue.length === 0) { return PromiseImpl.resolve(); }
            var slice = queue.splice(0, batchSize);
            var calls = slice.map(function (id) {
                return me.fetchVehicleTripsV3(id, tsUnix, teUnix, 8000)
                    .then(function (resp) {
                        results.push({ id: id, km: me.sumTripsKm(resp, kmField) });
                    })
                    .catch(function (err) {
                        console.warn('[promatic_dashboard_enhancer] Top KM trips-v3: vehículo ' +
                            id + ' falló (' + (err && err.message ? err.message : err) + ') — cuenta 0');
                        results.push({ id: id, km: 0 });
                    });
            });
            return PromiseImpl.all(calls).then(runBatch);
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

    // ratings.data (analytics/vehicles.php): keys[i] = [agent_id,
    // "placa - conductor - serie", modelo], veh_driving_dist[i] = km del
    // vehículo i, alineado 1:1 con keys. Ver spec/api.md. Lanza si el shape
    // no está, está desalineado, o no hay ningún km > 0 — eso dispara el
    // fallback a reports.php (p. ej. cuentas donde ratings viene deshabilitado).
    // Devuelve el ranking COMPLETO ordenado desc (todos los vehículos con
    // km > 0). renderTop5Km corta a `count` para mostrar; el link "ver todos"
    // del pie usa la lista entera.
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

    // reports.php report_type=4: report.data[fecha][vehículo] = array de
    // tramos, cada tramo con .length = km del tramo. Suma por vehículo.
    // nameToId: mapa opcional nombre→agentid para el link a Informes.
    // Devuelve el ranking completo ordenado desc (ver parseRatingsTop5).
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

    // ranked = [{ name, km, id? }] COMPLETO ordenado desc. days = ventana en
    // días; startDate/stopDate = rango real de la consulta; count = cuántas
    // filas muestra la card. El link "ver todos" del pie usa todo `ranked`.
    renderTop5Km: function (ranked, days, startDate, stopDate, count) {
        ranked = ranked || [];
        days = days || 7;
        count = count || 5;
        stopDate = stopDate || new Date();
        if (!startDate) {
            startDate = new Date();
            startDate.setDate(startDate.getDate() - days);
        }

        if (ranked.length === 0) {
            this.updateCardBody('top5km', l('Sin datos de kilometraje para el período.'));
            return;
        }

        var top5 = ranked.slice(0, count);

        var startMs = startDate.getTime();
        var stopMs = stopDate.getTime();

        // Barra apilada — segmento por vehículo, alto = % del total mostrado.
        // Colores fijos g2/g1/g3/g4/g5 en orden ascendente de km (diseño de
        // dev/proto-dash.html, 27 ago). Con más de 5 vehículos el ramp no da
        // — se cae a un tono único (var --g4) para no repetir colores.
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
                title: Ext.String.htmlEncode(ascending[a].name) + ' — ' + ascending[a].km.toFixed(0) + 'km'
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
                    { tag: 'span', cls: 'promatic_dashboard_enhancer-rank-name', html: Ext.String.htmlEncode(item.name) },
                    { cls: 'promatic_dashboard_enhancer-rank-track', cn: [
                        { cls: 'promatic_dashboard_enhancer-rank-fill', style: 'width:' + (item.km / maxKm * 100).toFixed(0) + '%' }
                    ] },
                    { tag: 'span', cls: 'promatic_dashboard_enhancer-rank-val', html: item.km.toFixed(0) + 'km' },
                    { tag: 'span', cls: 'promatic_dashboard_enhancer-chev', html: '›' }
                ]
            };
            if (hasId) {
                row.href = '#';
                row.title = l('Ver informe de kilómetros de') + ' ' + Ext.String.htmlEncode(item.name);
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
                    { cls: 'promatic_dashboard_enhancer-km-date-range', html: dateFmt(startDate) + ' — ' + dateFmt(stopDate) },
                    { cls: 'promatic_dashboard_enhancer-km-top5-label', html: l('Ranking') + ' &middot; ' + l('más recorrido') }
                ].concat(rankRows).concat([
                    { cls: 'promatic_dashboard_enhancer-km-color-legend', cn: [
                        { tag: 'span', cls: 'promatic_dashboard_enhancer-km-legend-grad' },
                        { html: l('Oscuro = más km · Claro = menos km') }
                    ] }
                ]) }
            ]
        }));

        // Link del pie de la card → informe de kilómetros de TODOS los
        // vehículos del ranking (no solo los `count` que muestra la card),
        // con el mismo rango. El pie se crea con la card (cardMarkup), antes
        // de tener datos — se completa acá.
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

    // Delegado de clicks para los links a Informes (filas del ranking + pie
    // de la card Top KM). Se bindea una vez sobre el elemento del panel.
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

    // Abre el panel nativo de Informes con el reporte de kilómetros
    // (report_type=4) para los vehículos y el rango dados.
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

    // Activa el tab de Informes en la navegación de PILOT. El índice varía
    // por cuenta — se busca por identidad/título/xtype y se cae al 2 (el
    // valor del ejemplo oficial de Pilot) si no se encuentra.
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

    // Función entregada por Pilot (2026-07-17, confirmada 22 jul) para
    // disparar un reporte nativo desde código — adaptada a método. Requiere
    // que el panel de Informes ya esté activo (ver activateReportsTab).
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
            // "Dividir" (explode_combo): buscar la opción "No dividir" en el
            // store por su etiqueta y setear su valueField real — NO un literal.
            // El valueField es "abbr" y "No dividir" = 3 en la cuenta de
            // pruebas, pero varía por cuenta/idioma; un setValue(0) fijo deja el
            // combo en estado inválido → explode="" en el submit → el job del
            // reporte nunca termina ("El informe está siendo creado" colgado).
            // Va después de selectReport (que reconfigura el form). Defensivo:
            // el combo puede no existir en otra cuenta.
            var explodeCombo = reports.down('#explode_combo');
            if (explodeCombo && explodeCombo.getStore) {
                var explodeStore = explodeCombo.getStore();
                var noSplit = explodeStore && explodeStore.findRecord(
                    'name', /no dividir|don't split|do not split|не разбивать/i, 0, false, false, false);
                // Fallback: "No dividir" es la última opción del store (abbr más
                // alto) en todas las cuentas vistas.
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
        // hijos del root se cargan lazy vía XHR tree.php?node=root (~1.4s).
        // Marcar+submitear antes de eso da 0 seleccionados → "Seleccione 1 o
        // más objetos" (BR-PILOT-0010). Se espera a que el árbol tenga nodos
        // reales: listener 'load' con guard de count, y un poll de respaldo
        // por si el store ya está poblado y no vuelve a emitir 'load'.
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

    // -----------------------------------------------------------------------
    // Assets
    // -----------------------------------------------------------------------

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

    // Carga dist/config.json y lo mergea (por sección, un nivel) sobre
    // DEFAULT_CONFIG. No bloquea el arranque: los widgets corren en el
    // 'afterrender' del panel (bastante después de initModule), para
    // entonces esto normalmente ya resolvió; si no, usan el default.
    // FUTURO (backend): agregar acá un segundo fetch a la URL del backend
    // y mergear su respuesta encima de la de config.json.
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
