Ext.define('Store.promatic_dashboard_enhancer.Module', {
    extend: 'Ext.Component',
    extensionName: 'promatic_dashboard_enhancer',

    initModule: function () {
        this.loadStyles();

        var mainPanel = this.buildMainPanel();
        var navTab = this.buildNavTab(mainPanel);

        navTab.map_frame = mainPanel;

        if (window.skeleton && skeleton.navigation && typeof skeleton.navigation.add === 'function') {
            skeleton.navigation.add(navTab);
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

    buildMainPanel: function () {
        this.summaryBar = Ext.create('Ext.Component', {
            cls: 'promatic_dashboard_enhancer-summary',
            html: l('Cargando estado de flota...')
        });

        var panel = Ext.create('Ext.panel.Panel', {
            cls: 'promatic_dashboard_enhancer-panel',
            layout: {
                type: 'vbox',
                align: 'stretch'
            },
            items: [
                this.summaryBar,
                this.buildFleetGrid(),
                this.buildSpeedingPanel()
            ]
        });

        this.bindFleetUpdates();

        return panel;
    },

    buildSpeedingPanel: function () {
        this.speedingChartEl = Ext.create('Ext.Component', {
            cls: 'promatic_dashboard_enhancer-chart',
            autoEl: { tag: 'div' },
            html: l('Cargando distribución de velocidad...')
        });

        var panel = Ext.create('Ext.panel.Panel', {
            title: l('Distribución de velocidad'),
            cls: 'promatic_dashboard_enhancer-speeding-panel',
            height: 260,
            items: [this.speedingChartEl]
        });

        this.loadSpeedingData();

        return panel;
    },

    loadSpeedingData: function () {
        var me = this;

        Ext.Ajax.request({
            url: '/backend/ax/dashboard/speeding_pie.php',
            method: 'GET',
            success: function (resp) {
                var data = Ext.decode(resp.responseText, true);
                if (data) {
                    me.renderSpeedingChart(data);
                }
            },
            failure: function () {
                if (me.speedingChartEl) {
                    me.speedingChartEl.update(l('No se pudo cargar la distribución de velocidad.'));
                }
            }
        });
    },

    renderSpeedingChart: function (data, attempt) {
        attempt = attempt || 0;

        if (!this.speedingChartEl || !this.speedingChartEl.rendered) {
            if (attempt < 20) {
                Ext.defer(this.renderSpeedingChart, 250, this, [data, attempt + 1]);
            }
            return;
        }

        if (!window.Highcharts) {
            this.speedingChartEl.update(l('Highcharts no está disponible en este runtime.'));
            return;
        }

        var categories = [];
        for (var i = 0; i < data.dist.length; i++) {
            // Rango de velocidad exacto por bucket sin confirmar todavía — ver spec/api.md
            categories.push(l('Rango') + ' ' + (i + 1));
        }

        Highcharts.chart(this.speedingChartEl.getEl().dom, {
            chart: { type: 'column' },
            title: { text: null },
            xAxis: { categories: categories, title: { text: l('Rango de velocidad') } },
            yAxis: { title: { text: l('Distancia (km)') } },
            series: [{ name: l('Distancia'), data: data.dist, color: '#2563EB' }],
            credits: { enabled: false },
            legend: { enabled: false }
        });
    },

    buildFleetGrid: function () {
        this.fleetStore = Ext.create('Ext.data.Store', {
            fields: ['agentid', 'name', 'group', 'driver', 'isOnline', 'statusText', 'lastUpdate']
        });

        return Ext.create('Ext.grid.Panel', {
            store: this.fleetStore,
            flex: 1,
            columns: [
                { text: l('Vehículo'), dataIndex: 'name', flex: 2 },
                { text: l('Grupo'), dataIndex: 'group', flex: 1 },
                { text: l('Conductor'), dataIndex: 'driver', flex: 1 },
                {
                    text: l('Estado'),
                    dataIndex: 'isOnline',
                    flex: 1,
                    renderer: function (value) {
                        return value ?
                            '<span class="promatic_dashboard_enhancer-dot promatic_dashboard_enhancer-dot-online"></span> ' + l('En línea') :
                            '<span class="promatic_dashboard_enhancer-dot promatic_dashboard_enhancer-dot-offline"></span> ' + l('Desconectado');
                    }
                },
                { text: l('Último estado'), dataIndex: 'statusText', flex: 2 },
                { text: l('Última actualización'), dataIndex: 'lastUpdate', flex: 1 }
            ]
        });
    },

    getOnlineTree: function () {
        return (window.skeleton && skeleton.navigation && skeleton.navigation.online &&
            skeleton.navigation.online.online_tree) || null;
    },

    bindFleetUpdates: function (attempt) {
        attempt = attempt || 0;
        var onlineTree = this.getOnlineTree();

        if (!onlineTree) {
            if (attempt < 20) {
                Ext.defer(this.bindFleetUpdates, 500, this, [attempt + 1]);
            } else if (this.summaryBar) {
                this.summaryBar.update(l('No se pudo conectar al árbol de vehículos de PILOT.'));
            }
            return;
        }

        onlineTree.getStore().on('datachanged', this.refreshFleetStore, this);
        onlineTree.getStore().on('update', this.refreshFleetStore, this);
        this.refreshFleetStore();
    },

    refreshFleetStore: function () {
        var onlineTree = this.getOnlineTree();
        if (!onlineTree || !this.fleetStore) {
            return;
        }

        var records = onlineTree.getStore().getData().items;
        var rows = [];

        for (var i = 0; i < records.length; i++) {
            var r = records[i];
            var agentid = r.get('agentid');

            if (!agentid) {
                continue; // nodo de grupo/carpeta, no un vehículo
            }

            rows.push({
                agentid: agentid,
                name: r.get('name'),
                group: r.get('group'),
                driver: r.get('driver'),
                isOnline: !!r.get('is_server_online'),
                statusText: r.get('status'),
                lastUpdate: r.get('msg1')
            });
        }

        this.fleetStore.loadData(rows);
        this.updateSummary();
    },

    updateSummary: function () {
        if (!this.summaryBar || !this.fleetStore) {
            return;
        }

        var total = this.fleetStore.getCount();
        var online = 0;

        this.fleetStore.each(function (rec) {
            if (rec.get('isOnline')) {
                online++;
            }
        });

        var pct = total > 0 ? Math.round((online / total) * 100) : 0;

        this.summaryBar.update(
            l('Flota') + ': ' + total +
            ' &nbsp;|&nbsp; <span class="promatic_dashboard_enhancer-dot promatic_dashboard_enhancer-dot-online"></span> ' +
            online + ' ' + l('en línea') + ' (' + pct + '%)' +
            ' &nbsp;|&nbsp; <span class="promatic_dashboard_enhancer-dot promatic_dashboard_enhancer-dot-offline"></span> ' +
            (total - online) + ' ' + l('desconectados') +
            ' &nbsp;—&nbsp; ' + l('actualizado') + ' ' + Ext.Date.format(new Date(), 'H:i:s')
        );
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

    loadStyles: function () {
        var css = document.createElement('link');
        css.setAttribute('rel', 'stylesheet');
        css.setAttribute('type', 'text/css');
        css.setAttribute('href', this.getModuleBaseUrl() + 'style.css');
        document.head.appendChild(css);
    }
});
