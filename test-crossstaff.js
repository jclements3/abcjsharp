// Test: cross-staff notehead collision in grand-staff (brace) systems.
// Renders synthetic grand-staff ABCs through the built dist and inspects
// SVG noteheads to verify (a) baseline collisions and (b) the cross-staff
// printer_shift fix moves the lower-pitched notehead by ~1 notehead width.

var fs = require("fs");
var path = require("path");
var { JSDOM } = require("jsdom");

// Allow choosing which build artifact to test.  We test the development build
// because it's identical in behavior to the min build but easier to debug.
var DIST = process.env.ABCJS_DIST || path.resolve(__dirname, "dist/abcjs-basic.js");

function makeWindow() {
	var dom = new JSDOM("<!doctype html><html><body><div id='target'></div></body></html>", { pretendToBeVisual: true });
	global.window = dom.window;
	global.document = dom.window.document;
	global.navigator = dom.window.navigator;
	// Some abcjs draw code uses XMLSerializer / DOMParser indirectly.
	global.XMLSerializer = dom.window.XMLSerializer;
	global.DOMParser = dom.window.DOMParser;
	return dom;
}

function loadAbcjs() {
	// Clear require cache so we get a fresh load if needed.
	delete require.cache[require.resolve(DIST)];
	// abcjs-basic is a UMD: under Node it exports via module.exports.
	var abcjs = require(DIST);
	global.window.ABCJS = abcjs;
	return abcjs;
}

function renderAndGetNoteheads(abc) {
	var dom = makeWindow();
	var abcjs = loadAbcjs();
	abcjs.renderAbc("target", abc, { add_classes: true, responsive: "resize" });
	var svg = dom.window.document.querySelector("#target svg");
	if (!svg) throw new Error("No svg rendered");
	// Note glyphs are placed inside <g> elements with class names like
	// "abcjs-note" containing a notehead path/use. The minified dist may use
	// raw paths. We look at <path> and <use> noteheads via the data-name or
	// 'abcjs-notehead' class. To be robust, we look at all <use> with hrefs to
	// note glyphs, AND any path that has classname including "abcjs-note".
	// Cleanest: collect all svg <use> hrefs starting with #abcjs- glyph.
	// Actually abcjs draws noteheads as <path> (not <use>). The element has
	// the class "abcjs-notehead". Let's use that.
	var heads = Array.from(svg.querySelectorAll("path.abcjs-notehead"));
	return heads.map(function (h) {
		// abcjs encodes the absolute coordinates into the path's "d" attribute via
		// an initial "M x y". Extract that as the notehead's position.
		var d = h.getAttribute("d") || "";
		var m = d.match(/M\s+([\-0-9.]+)\s+([\-0-9.]+)/);
		var x = m ? parseFloat(m[1]) : NaN;
		var y = m ? parseFloat(m[2]) : NaN;
		return { x: x, y: y, name: h.getAttribute("data-name"), node: h };
	});
}

function runCase(label, abc, predicate) {
	var heads = renderAndGetNoteheads(abc);
	var xs = heads.map(function (h) { return h.x.toFixed(2); }).join(", ");
	var ys = heads.map(function (h) { return h.y.toFixed(2); }).join(", ");
	console.log("\n=== " + label + " ===");
	console.log("  noteheads: " + heads.length + " | x: [" + xs + "] | y: [" + ys + "]");
	var result = predicate(heads);
	console.log("  result: " + (result.ok ? "PASS" : "FAIL") + " — " + result.msg);
	return result.ok;
}

// Convention: in each test we expect exactly 2 noteheads from the two single-note
// voices (one in treble, one in bass).  After the fix, adjacent cross-staff
// pitches should have horizontally offset noteheads (~one notehead width apart).
// Non-adjacent pitches and same-pitched superpositions should remain aligned.

var cases = [
	{
		label: "treble C4 + bass B3 (adjacent — should shift)",
		abc:
			"X:1\nT:t\nM:4/4\nL:1/4\n%%score {1 | 2}\n%%sysstaffsep 12\n" +
			"V:1 clef=treble\nV:2 clef=bass\nK:C\n" +
			"[V:1] C |]\n[V:2] B, |]\n",
		shouldShift: true
	},
	{
		label: "treble D4 + bass C4 (adjacent — should shift)",
		abc:
			"X:1\nT:t\nM:4/4\nL:1/4\n%%score {1 | 2}\n%%sysstaffsep 12\n" +
			"V:1 clef=treble\nV:2 clef=bass\nK:C\n" +
			"[V:1] D |]\n[V:2] C |]\n",
		shouldShift: true
	},
	{
		label: "treble C4 + bass C4 (same pitch — should NOT shift)",
		abc:
			"X:1\nT:t\nM:4/4\nL:1/4\n%%score {1 | 2}\n%%sysstaffsep 12\n" +
			"V:1 clef=treble\nV:2 clef=bass\nK:C\n" +
			"[V:1] C |]\n[V:2] C |]\n",
		shouldShift: false
	},
	{
		label: "treble E4 + bass B3 (not adjacent — should NOT shift)",
		abc:
			"X:1\nT:t\nM:4/4\nL:1/4\n%%score {1 | 2}\n%%sysstaffsep 12\n" +
			"V:1 clef=treble\nV:2 clef=bass\nK:C\n" +
			"[V:1] E |]\n[V:2] B, |]\n",
		shouldShift: false
	}
];

// Threshold:  a single notehead is ~7-9 px wide in the default rendering.
// We say "shifted" when the two x coords differ by >= 5 px,
// and "aligned"  when they differ by <  3 px.
var SHIFT_THRESHOLD = 5;
var ALIGN_THRESHOLD = 3;

var anyFail = false;
cases.forEach(function (c) {
	var ok = runCase(c.label, c.abc, function (heads) {
		if (heads.length < 2)
			return { ok: false, msg: "expected at least 2 noteheads, got " + heads.length };
		var xs = heads.map(function (h) { return h.x; });
		var minX = Math.min.apply(null, xs);
		var maxX = Math.max.apply(null, xs);
		var dx = maxX - minX;
		if (c.shouldShift) {
			return {
				ok: dx >= SHIFT_THRESHOLD,
				msg: "expected shift (dx >= " + SHIFT_THRESHOLD + "), got dx=" + dx.toFixed(2)
			};
		} else {
			return {
				ok: dx <= ALIGN_THRESHOLD,
				msg: "expected aligned (dx <= " + ALIGN_THRESHOLD + "), got dx=" + dx.toFixed(2)
			};
		}
	});
	if (!ok) anyFail = true;
});

console.log("\n" + (anyFail ? "FAILURES detected" : "All cases pass"));
process.exit(anyFail ? 1 : 0);
