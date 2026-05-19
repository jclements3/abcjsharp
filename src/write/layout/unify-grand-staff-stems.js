// Cross-staff stem-direction unification — HARP-SPECIFIC RULE.
//
// Standard abcjs/piano-engraving picks stem direction per-element by note
// position relative to the staff's middle line. For harp music, that
// convention is ambiguous about WHICH HAND plays the chord. The harp
// convention used here is unambiguous:
//   - Treble staff (right hand) -> ALL stems UP -> stems sit on the RIGHT
//     of the notehead
//   - Bass staff (left hand) -> ALL stems DOWN -> stems sit on the LEFT
//     of the notehead
//
// Combined with the converter's pitch-based note assignment (notes at or
// above middle C go to treble = right hand; below middle C to bass = left
// hand) and the chord-span split (chord spanning > 10 strings migrates the
// outlier note(s) to the other staff), this gives the harp player an
// at-a-glance hand cue: stem side == which hand to use.
//
// This pass runs after abstract-engraver has built notes with the default
// per-element direction and after `applyCrossStaffShifts` (Agent A's cross-
// staff notehead-collision shift). It then forces every note's stem to the
// staff-determined direction:
//   - Rewrites each notehead's stemDir
//   - Rewrites the stem RelativeElement's pitch/pitch2/dx/linewidth (so the
//     stem is drawn the correct length on the correct side)
//   - For beamed groups: flips beam.stemsUp / forceup / forcedown
//
// Skipped:
//   - Rests
//   - Notes in non-brace/bracket staff groups (single-voice hymns)
//   - Notehead-shift state (we leave Agent A's cross-staff notehead x-offsets
//     alone)

// Find the stem RelativeElement in an un-beamed absolute element.
// The stem RelativeElement is added via abselem.addRight() (see
// abstract-engraver.js:767) which appends to `this.right`, NOT `this.children`.
// Check both for safety; future versions of abcjs could reorganize.
function findStem(abselem) {
	if (!abselem) return null;
	if (abselem.beam) return null; // beamed: handled separately via beam.stemsUp
	var arrays = [abselem.right, abselem.children, abselem.extra];
	for (var a = 0; a < arrays.length; a++) {
		var arr = arrays[a];
		if (!arr) continue;
		for (var i = 0; i < arr.length; i++) {
			var ch = arr[i];
			if (ch && ch.type === 'stem') return ch;
		}
	}
	return null;
}

// Reverse a stem RelativeElement to point in the opposite direction.
// Mirrors the geometry that abstract-engraver.addNoteToAbcElement built:
//   stem-up:   pitch  = minpitch + 1/3
//              pitch2 = maxpitch + stemHeight
//              dx     = heads[0].w
//              linewidth = -1
//   stem-down: pitch  = minpitch - stemHeight
//              pitch2 = maxpitch - 1/3
//              dx     = 0
//              linewidth = 1
// Direction is encoded in stem.linewidth: negative -> up, positive -> down
// (pitch < pitch2 in BOTH directions, so we can't rely on pitch ordering).
function rebuildStem(abselem, stem, newDir) {
	if (!abselem || !abselem.abcelem) return;
	var minp = abselem.abcelem.minpitch;
	var maxp = abselem.abcelem.maxpitch;
	if (minp === undefined || maxp === undefined) return;
	var currentDir = (stem.linewidth !== undefined && stem.linewidth < 0) ? 'up' : 'down';
	if (currentDir === newDir) return;

	var stemHeight;
	if (currentDir === 'up') {
		stemHeight = stem.pitch2 - maxp;
	} else {
		stemHeight = minp - stem.pitch;
		if (stemHeight < 1) {
			stemHeight = (stem.pitch2 + 1 / 3) - stem.pitch;
		}
	}
	if (!isFinite(stemHeight) || stemHeight < 1) stemHeight = 7;

	var headW = (abselem.heads && abselem.heads.length > 0) ? abselem.heads[0].w : 0;
	if (newDir === 'up') {
		stem.pitch = minp + 1 / 3;
		stem.pitch2 = maxp + stemHeight;
		stem.dx = headW;
		stem.linewidth = -1;
	} else {
		stem.pitch = minp - stemHeight;
		stem.pitch2 = maxp - 1 / 3;
		stem.dx = 0;
		stem.linewidth = 1;
	}
	stem.top = Math.max(stem.pitch, stem.pitch2);
	stem.bottom = Math.min(stem.pitch, stem.pitch2);
	// The first layout pass (setXSpacing → AbsoluteElement.setX) has already
	// cascaded setX through the children, so stem.x was computed as
	// (abselem.x + OLD stem.dx). Now that we changed stem.dx, the cached
	// stem.x is stale and won't be refreshed by the remainder of the layout
	// pipeline (setUpperAndLowerElements / layoutVoice don't re-cascade
	// setX). Recompute stem.x here so it tracks the new dx.
	stem.x = abselem.x + stem.dx;

	if (abselem.heads) {
		for (var h = 0; h < abselem.heads.length; h++) {
			abselem.heads[h].stemDir = newDir;
		}
	}

	flipFlag(abselem, newDir, headW);
	flipShiftedHeads(abselem, newDir);
}

// Adjacent-diatonic-2nd noteheads carry a `printer_shift` flag from the
// parser. create-note-head.js positions them via the direction-dependent
// formula
//   dir=up   →  dx = + (notehead.w - adjust)
//   dir=down →  dx = − (notehead.w - adjust)
// so when rebuildStem flips the stem direction we must re-sign each
// shifted head's dx, otherwise the head lands on the wrong side of the
// stem (a notehead floating in space, the stem missing it entirely).
// Mirrors create-note-head.js's `shiftheadx` calculation.
function flipShiftedHeads(abselem, newDir) {
	if (!abselem || !abselem.heads || !abselem.abcelem) return;
	var pitches = abselem.abcelem.pitches;
	if (!pitches) return;
	for (var i = 0; i < abselem.heads.length && i < pitches.length; i++) {
		var ps = pitches[i] && pitches[i].printer_shift;
		if (!ps) continue;
		var head = abselem.heads[i];
		var adjust = (ps === 'same') ? 1 : 0;
		var newDx = (newDir === 'down') ? -head.w + adjust : head.w - adjust;
		head.dx = newDx;
		// stem.x is cached after the first layout pass; same fix as in
		// rebuildStem — refresh from the new dx so the head renders where
		// we just put it.
		head.x = abselem.x + head.dx;
	}
}

// Unbeamed short notes have a flag glyph (flags.u8th / flags.d8th, etc.)
// added via abselem.addRight at engraving time. The glyph's name AND its
// dx / pitch are baked in for the direction abcjs originally chose. When
// rebuildStem flips the stem direction we must also swap the flag glyph
// so it sits at the new stem tip instead of dangling on the wrong side
// of the notehead (which reads as a "stem connected to nothing").
//
// Layout matches create-note-head.js:
//   dir=up:   pos = topPitch + 7;     xdelta = notehead.w - 0.6
//   dir=down: pos = bottomPitch - 7;  xdelta = 0
function flipFlag(abselem, newDir, headW) {
	var flag = findFlag(abselem);
	if (!flag || !flag.c) return;
	// flag.c looks like "flags.u8th" / "flags.d16th" / ...
	var m = /^flags\.[ud](.+)$/.exec(flag.c);
	if (!m) return; // not a regular up/down flag (ugrace/dgrace handled too if needed, but ignore here)
	var kind = m[1]; // "8th", "16th", "32nd", "64th"
	var newC = 'flags.' + (newDir === 'up' ? 'u' : 'd') + kind;
	if (flag.c === newC) return;

	flag.c = newC;
	flag.name = newC;
	if (newDir === 'up') {
		flag.pitch = abselem.abcelem.maxpitch + 7;
		flag.dx = headW - 0.6;
	} else {
		flag.pitch = abselem.abcelem.minpitch - 7;
		flag.dx = 0;
	}
	// stem.x cached from the old dx; refresh from the new one.
	flag.x = abselem.x + flag.dx;
	flag.top = flag.pitch;
	flag.bottom = flag.pitch;
}

function findFlag(abselem) {
	if (!abselem) return null;
	var arrays = [abselem.right, abselem.children, abselem.extra];
	for (var a = 0; a < arrays.length; a++) {
		var arr = arrays[a];
		if (!arr) continue;
		for (var i = 0; i < arr.length; i++) {
			var ch = arr[i];
			if (ch && typeof ch.c === 'string' && ch.c.indexOf('flags.') === 0) return ch;
		}
	}
	return null;
}

function unifyOneLine(staffGroup) {
	if (!staffGroup || !staffGroup.staffs) return;
	// Only apply the harp staff-based rule if we have a grand staff (>= 2
	// staves grouped). Single-staff music keeps abcjs's default per-element
	// direction.
	if (staffGroup.staffs.length < 2) return;

	for (var s = 0; s < staffGroup.staffs.length; s++) {
		var staff = staffGroup.staffs[s];
		var dir = (s === 0) ? 'up' : 'down';
		if (!staff || !staff.voices) continue;

		var beamsSeen = new Set();
		for (var v = 0; v < staff.voices.length; v++) {
			var voice = staffGroup.voices[staff.voices[v]];
			if (!voice || !voice.children) continue;

			for (var c = 0; c < voice.children.length; c++) {
				var abselem = voice.children[c];
				if (!abselem || !abselem.heads || abselem.heads.length === 0) continue;
				if (abselem.abcelem && abselem.abcelem.rest) continue;

				// Harp convention: ALL stems on the treble staff go UP (right
				// hand) and ALL stems on the bass staff go DOWN (left hand) —
				// including single notes. Stem side unambiguously tells the
				// player which hand plays. Otherwise a single RH note at the
				// middle of the staff would get abcjs's default down-stem and
				// visually merge with the LH stem at the same x.
				if (abselem.beam) {
					beamsSeen.add(abselem.beam);
					for (var h = 0; h < abselem.heads.length; h++) {
						abselem.heads[h].stemDir = dir;
					}
					continue;
				}
				var stem = findStem(abselem);
				if (!stem) continue;
				rebuildStem(abselem, stem, dir);
			}
		}

		// Beams: flip group direction in one shot. (We've already iterated
		// every member to set its head.stemDir above.)
		beamsSeen.forEach(function (beam) {
			beam.stemsUp = (dir === 'up');
			beam.forceup = beam.stemsUp;
			beam.forcedown = !beam.stemsUp;
		});
	}
}

function unifyGrandStaffStems(abcLines) {
	if (!abcLines) return;
	for (var i = 0; i < abcLines.length; i++) {
		var line = abcLines[i];
		if (!line || !line.staffGroup) continue;
		unifyOneLine(line.staffGroup);
	}
}

module.exports = unifyGrandStaffStems;
