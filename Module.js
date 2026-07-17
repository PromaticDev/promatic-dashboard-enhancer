/**
 * promatic-dashboard-pilot — Skeleton inicial
 * Objetivo: confirmar que la extensión carga y se comporta correctamente
 * dentro del entorno PILOT antes de construir la lógica real del dashboard.
 *
 * Extension name (slug): promatic_dashboard_enhancer
 * Clase generada por PILOT: Store.promatic_dashboard_enhancer.Module
 */

Ext.define('Store.promatic_dashboard_enhancer.Module', {
    extend: 'Ext.Component',

    initModule: function () {
        console.log('[promatic_dashboard_enhancer] Extension loading...');

        // 1. TAB DE NAVEGACIÓN (panel izquierdo)
        var navTab = Ext.create('Pilot.utils.LeftBarPanel', {
            title: 'Dashboard Pilot',
            iconCls: 'fa fa-zap',
            iconAlign: 'top',
            minimized: true,
            items: [
                {
                    xtype: 'panel',
                    title: 'Panel',
                    iconCls: 'fa fa-th-large',
                    layout: 'fit',
                    html: '<div style="padding:20px;">Skeleton cargado correctamente.</div>'
                }
            ]
        });

        // 2. PANEL PRINCIPAL (área central)
        var mainPanel = Ext.create('Ext.panel.Panel', {
            layout: 'fit',
            html: `
                <div style="padding: 30px;">
                    <h2>promatic-dashboard-pilot — Skeleton inicial</h2>
                    <p>Si ves esto, la extensión cargó y se enganchó correctamente
                    a <code>skeleton.navigation</code> y <code>skeleton.mapframe</code>.</p>
                    <p>Próximo paso: reemplazar este contenido por el sistema de
                    widgets/mosaicos configurables.</p>
                </div>
            `
        });

        // 3. ENLAZAR TAB CON PANEL PRINCIPAL
        navTab.map_frame = mainPanel;

        // 4. REGISTRAR EN LA UI DE PILOT
        skeleton.navigation.add(navTab);
        skeleton.mapframe.add(mainPanel);

        // 5. CARGAR ESTILOS PROPIOS
        this.loadStyles();

        console.log('[promatic_dashboard_enhancer] Extension initialized successfully.');
    },

    loadStyles: function () {
        var cssLink = document.createElement('link');
        cssLink.setAttribute('rel', 'stylesheet');
        cssLink.setAttribute('type', 'text/css');
        cssLink.setAttribute('href', '/store/promatic_dashboard_enhancer/style.css');
        document.head.appendChild(cssLink);
    }
});