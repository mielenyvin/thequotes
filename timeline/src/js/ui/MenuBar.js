import * as DOM from "../dom/DOM"
import Events from "../core/Events";
import { DOMMixins } from "../dom/DOMMixins"
import { easeInOutQuint } from "../animation/Ease"
import { classMixin, mergeData } from "../core/Util"
import { DOMEvent } from "../dom/DOMEvent"
import { I18NMixins } from "../language/I18NMixins";

export class MenuBar {
    constructor(elem, parent_elem, options, language) {
        // DOM ELEMENTS
        this._el = {
            parent: {},
            container: {},
            button_backtostart: {},
            button_zoomin: {},
            button_zoomout: {},
            arrow: {},
            line: {},
            coverbar: {},
            grip: {}
        };

        this.collapsed = false;

        if (typeof elem === 'object') {
            this._el.container = elem;
        } else {
            this._el.container = DOM.get(elem);
        }

        if (parent_elem) {
            this._el.parent = parent_elem;
        }

        // Data
        this.data = {
            visible_ticks_dates: {}
        }

        //Options
        this.options = {
            width: 600,
            height: 600,
            duration: 1000,
            ease: easeInOutQuint,
            menubar_default_y: 0
        };

        // Animation
        this.animator = {};

        this.setLanguage(language)

        // Merge Data and Options
        mergeData(this.options, options);

        this._initLayout();
        this._initEvents();
    }

    /*	Public
    ================================================== */
    show(d) {

        var duration = this.options.duration;
        if (d) {
            duration = d;
        }
    }

    hide(top) { }

    toogleZoomIn(show) {
        if (show) {
            this._el.button_zoomin.removeAttribute('disabled');
        } else {
            this._el.button_zoomin.setAttribute('disabled', true);
        }
    }

    toogleZoomOut(show) {
        if (show) {
            this._el.button_zoomout.removeAttribute('disabled');
        } else {
            this._el.button_zoomout.setAttribute('disabled', true);
        }
    }

    changeVisibleTicks(visible_ticks) {
        const minor_ticks = visible_ticks.minor;
        if (!minor_ticks.length) {
            this.data.visible_ticks_dates = {};
            return;
        }

        const firstTick = minor_ticks[0];
        const firstYear = firstTick.date.getFullYear();

        const lastTick = minor_ticks[minor_ticks.length - 1];
        const lastYear = lastTick.date.getFullYear();

        this.data.visible_ticks_dates = {
            start: firstYear,
            end: lastYear
        };

        this._updateZoomAriaLabels()
    }

    setSticky(y) {
        this.options.menubar_default_y = y;
    }

    /*	Color
    ================================================== */
    setColor(inverted) {
        if (inverted) {
            this._el.container.className = 'tl-menubar tl-menubar-inverted';
        } else {
            this._el.container.className = 'tl-menubar';
        }
    }

    /*	Update Display
    ================================================== */
    updateDisplay(w, h, a, l) {
        this._updateDisplay(w, h, a, l);
    }

    /*	Events
    ================================================== */
    _onButtonZoomIn(e) {
        this.fire("zoom_in", e);
    }

    _onButtonZoomOut(e) {
        this.fire("zoom_out", e);
    }

    _onButtonBackToStart(e) {
        this._pauseSoundCloud();
        this.fire("back_to_start", e);
    }


    /*	Private Methods
    ================================================== */
    _initLayout() {

        // Create Layout (make "back to start" first so it appears at the top of the list)
        this._el.button_backtostart = DOM.createButton('tl-menubar-button', this._el.container);
        this._el.button_zoomin = DOM.createButton('tl-menubar-button', this._el.container);
        this._el.button_zoomout = DOM.createButton('tl-menubar-button', this._el.container);

        this._el.button_backtostart.innerHTML = "<span class='tl-icon-home'></span>";
        this._el.button_backtostart.setAttribute('aria-label', this._('return_to_title'));

        this._el.button_zoomin.innerHTML = "<span class='tl-icon-zoom-in'></span>";
        this._el.button_zoomin.setAttribute('aria-label', this._('zoom_in'));

        this._el.button_zoomout.innerHTML = "<span class='tl-icon-zoom-out'></span>";
        this._el.button_zoomout.setAttribute('aria-label', this._('zoom_out'));
    }

    _initEvents() {
        DOMEvent.addListener(this._el.button_backtostart, 'click', this._onButtonBackToStart, this);
        DOMEvent.addListener(this._el.button_zoomin, 'click', this._onButtonZoomIn, this);
        DOMEvent.addListener(this._el.button_zoomout, 'click', this._onButtonZoomOut, this);

        // Show the "home" button only when we are not on the title slide.
        if (typeof window !== 'undefined') {
            const updateHomeVisibility = () => {
                const btn = this._el.button_backtostart;
                if (!btn) return;

                let isOnTitle = true;

                try {
                    const tl = window.timeline;

                    if (tl && tl.config && Array.isArray(tl.config.events)) {
                        const currentId = tl.current_id;
                        const events = tl.config.events;

                        const idx = events.findIndex(ev => ev.unique_id === currentId);

                        // If current_id matches one of the events, we are NOT on the title slide
                        if (idx >= 0) {
                            isOnTitle = false;
                        } else {
                            isOnTitle = true;
                        }
                    } else {
                        // Fallback: use URL hash heuristic
                        const hash = window.location.hash || '';
                        isOnTitle = !hash || !hash.includes('event-');
                    }
                } catch (e) {
                    // In case of any error, be safe and treat as title
                    isOnTitle = true;
                }

                if (isOnTitle) {
                    btn.style.display = 'none';
                } else {
                    btn.style.display = '';
                }
            };

            // Initial visibility (slightly delayed to allow timeline to initialize)
            setTimeout(updateHomeVisibility, 0);

            // If a global timeline instance exists and supports events, update on slide change
            try {
                const tl = window.timeline;
                if (tl && typeof tl.on === 'function') {
                    tl.on('change', () => {
                        updateHomeVisibility();
                    });
                } else {
                    // Fallback: update when the URL hash changes
                    window.addEventListener('hashchange', updateHomeVisibility);
                }
            } catch (e) {
                // As a last resort, just use hashchange
                window.addEventListener('hashchange', updateHomeVisibility);
            }
        }
    }

    // Update Display
    _updateDisplay(width, height, animate) {

        if (width) {
            this.options.width = width;
        }
        if (height) {
            this.options.height = height;
        }
    }

    // Update Display
    _updateZoomAriaLabels() {
        if (Object.keys(this.data.visible_ticks_dates).length == 0) {
            this._el.button_zoomin.setAttribute('aria-description', '');
            this._el.button_zoomout.setAttribute('aria-description', '');
        } else {
            this._el.button_zoomin.setAttribute('aria-description',
                this._("aria_label_zoomin",
                    this.data.visible_ticks_dates));
            this._el.button_zoomout.setAttribute('aria-description',
                this._("aria_label_zoomout",
                    this.data.visible_ticks_dates));
        }
    }
    _pauseSoundCloud() {
        // Pause SoundCloud widget (if present) when interacting with menubar buttons
        try {
            if (typeof window !== 'undefined' && window.SC && typeof window.SC.Widget === 'function') {
                // Try to find a SoundCloud iframe inside the timeline embed first
                var iframe = document.querySelector('#timeline-embed iframe[src*="w.soundcloud.com/player"]');
                if (!iframe) {
                    // Fallback: search any SoundCloud player iframe on the page
                    iframe = document.querySelector('iframe[src*="w.soundcloud.com/player"]');
                }
                if (iframe) {
                    var widget = window.SC.Widget(iframe);
                    widget.pause();
                }
            }
        } catch (e) {
            // Fail silently if SoundCloud API is not available
        }
    }
}

classMixin(MenuBar, DOMMixins, Events, I18NMixins)
