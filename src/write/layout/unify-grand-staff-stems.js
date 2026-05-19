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
function findStem(abselem) {
	if (!abselem || !abselem.children) return null;
	if (abselem.beam) return null; // beamed: handled separately via beam.stemsUp
	for (var i = 0; i < abselem.children.length; i++) {
		var ch = abselem.children[i];
		if (ch && ch.type === 'stem') return ch;
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

	if (abselem.heads) {
		for (var h = 0; h < abselem.heads.length; h++) {
			abselem.heads[h].stemDir = newDir;
		}
	}
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

				// The staff-based stem-side rule is meaningful for CHORDS
				// (multi-notehead elements) — stem side tells the harp player
				// which hand plays the chord. A single notehead has no "set
				// of notes" to indicate side on, and forcing a low single
				// note's stem downward into empty space below the staff (or
				// a high single note's upward into space above) looks wrong.
				// For single noteheads, leave abcjs's default direction
				// (which extends toward the staff middle).
				if (abselem.heads.length < 2) continue;

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
