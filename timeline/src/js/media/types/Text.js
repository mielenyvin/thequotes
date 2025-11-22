import { classMixin, setData, mergeData, htmlify, linkify, trace } from "../../core/Util"
import Events from "../../core/Events"
import * as DOM from "../../dom/DOM"

export class Text {
	constructor(data, options, add_to_container) {

		this._el = { // defaults
			container: { },
			content_container: { },
			content: { },
            headline_container: { },
			headline: { },
			date: { }
		}

		this.options = { // defaults
			title: false
		}

		this.data = { // defaults
			unique_id: "",
			headline: "headline",
			text: "text"
		}

		setData(this, data); // override defaults

		// Merge Options
		mergeData(this.options, options);

		this._el.container = DOM.create("div", "tl-text");
		this._el.container.id = this.data.unique_id;

		this._initLayout();

		if (add_to_container) {
			add_to_container.appendChild(this._el.container);
		};

	}

	/*	Adding, Hiding, Showing etc
	================================================== */
	show() {

	}

	hide() {

	}

	addTo(container) {
		container.appendChild(this._el.container);
		//this.onAdd();
	}

	removeFrom(container) {
		container.removeChild(this._el.container);
	}

	headlineHeight() {
		return this._el.headline.offsetHeight + 40;
	}

	addDateText(str) {
		this._el.date.innerHTML = str;
	}

	/*	Events
	================================================== */
	onLoaded() {
		this.fire("loaded", this.data);
	}

	onAdd() {
		this.fire("added", this.data);
	}

	onRemove() {
		this.fire("removed", this.data);
	}

	/*	Private Methods
	================================================== */
	_initLayout() {

		// Create Layout
		this._el.content_container = DOM.create("div", "tl-text-content-container", this._el.container);
		this._el.headline_container = DOM.create("div", "tl-text-headline-container", this._el.content_container);

        // Headline
        if (this.data.headline != "") {
            var headline_class = "tl-headline";
            if (this.options.title) {
                headline_class = "tl-headline tl-headline-title";
            }
            this._el.headline = DOM.create("h2", headline_class, this._el.headline_container);
            this._el.headline.innerHTML		= this.data.headline;
        }

        // Date
		this._el.date = DOM.create("h3", "tl-headline-date", this._el.headline_container);

		// Text
		if (this.data.text != "") {
			var text_content = "";
			text_content += htmlify(this.options.autolink == true ? linkify(this.data.text) : this.data.text);
			this._el.content				= DOM.create("div", "tl-text-content", this._el.content_container);
			this._el.content.innerHTML		= text_content;

			// Make images with class `tl-expandable-img` expandable on click
			var expandableLinks = this._el.content.querySelectorAll('.tl-expandable-img-link');
			if (expandableLinks && expandableLinks.length > 0) {
				Array.prototype.forEach.call(expandableLinks, function(link) {
					var img = link.querySelector('img.tl-expandable-img');
					if (!img) { return; }

					// Store original sizes so we can restore them later
					if (!img.dataset.originalHeight) {
						img.dataset.originalHeight = img.style.height || "";
					}
					if (!img.dataset.originalMaxHeight) {
						img.dataset.originalMaxHeight = img.style.maxHeight || "";
					}
					if (!img.dataset.expanded) {
						img.dataset.expanded = "0";
					}

					link.addEventListener('click', function(e) {
						e.preventDefault();

						if (img.dataset.expanded === "1") {
							// collapse back to original size
							img.style.height = img.dataset.originalHeight;
							img.style.maxHeight = img.dataset.originalMaxHeight;
							img.dataset.expanded = "0";
						} else {
							// expand image
							img.style.height = "auto";
							img.style.maxHeight = "none";
							img.dataset.expanded = "1";
						}
					});
				});
			}
		}

		// Fire event that the slide is loaded
		this.onLoaded();

	}

}

classMixin(Text, Events)
