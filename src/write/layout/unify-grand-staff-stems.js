// Cross-staff stem-direction unification.
//
// abcjs computes stem direction per-voice using a single-staff heuristic
// (`elem.averagepitch >= 6 ? down : up` — see abstract-engraver.js:640).
// On a grand staff this routinely produces stems that disagree across the
// brace, e.g. a low-treble note and a high-bass note both want stems "down"
// from their staff's perspective but in piano-engraving convention the two
// voices should share a unified holistic direction.
//
// This pass — Phase 1 of the cross-staff stem work, "per-slot direction
// unification" only — runs after voice-collision and cross-staff notehead
// shifts.  For each time bucket that contains notes in BOTH staves of a
// brace-grouped staff group, it computes a holistic direction in concert
// pitch space (using voice.clefMid, which Agent A populates in
// createABCStaff) and rewrites:
//   - each notehead's stemDir
//   - the stem RelativeElement's pitch / pitch2 (so the stem is drawn the
//     right length the right way), preserving the existing stemHeight
//   - the dx and linewidth of the stem (since up-stems sit at x=head.w,
//     down-stems at x=0; linewidth signs the path's "handedness")
// For beamed notes, the stem RelativeElement is created by layout/beam.js
// AFTER this pass via createStems, so we instead override beam.stemsUp and
// rewrite each member head's stemDir.  layoutBeam (called downstream by
// staff-group's setHeight path? actually no — beams are laid out via
// voiceElements / draw path) will then read the updated stemsUp.
//
// Conventions (standard piano engraving):
//   - All notes below middle line of the grand staff (concert C4) -> up
//   - All notes above middle (concert C4) -> down
//   - Mixed register straddling middle by more than a 5th -> outward
//     (treble stems up, bass stems down)
//   - Otherwise (close-spaced both-sides or moderately mixed) -> down
//     (the default piano convention when stems unify)
//
// We do NOT touch:
//   - Time slots with notes in only one staff (the per-voice heuristic
//     already gives the right answer for those — the voice IS the staff
//     in that slot).
//   - Voices in non-brace/bracket staff groups.
//   - Rests (no stem direction to choose).
//   - The cross-staff notehead-shift state (Agent A's pass).

var toTimeAndGrandStaffBased = require('./to-time-and-grand-staff-based');

// Concert-pitch space in abcjs: each pitch carries `verticalPos`, which is
// the pitch's position relative to that staff's middle.  Concert pitch is
// `verticalPos + voice.clefMid` (clefMid is `abcstaff.clef.verticalPos`,
// the absolute pitch that sits on the middle staff line — 0 for treble,
// -12 for bass, etc., from abc_parse_key_voice.js:24-67).  So concert
// pitch == the same absolute integer pitch across all clefs, with
// middle C == 0.  We anchor stem decisions on middle C as the midline.
var MIDLINE = 0;

function concertPitch(voice, verticalPos) {
	var mid = (voice && voice.clefMid !== undefined) ? voice.clefMid : 0;
	return verticalPos + mid;
}

// Decide a direction ("up" / "down") for each entry in the slot, given
// the concert pitches of all noteheads.  Returns a map keyed by the
// entry's "key" string (voiceIndex:abselemIndex) -> "up"|"down" — or
// returns null if no change should be made (everything already agrees
// with the per-voice decision or the slot is single-staff).
function decideDirections(entries, midline) {
	// Collect concert pitches across the slot, grouped by staff index.
	var perStaff = {}; // staffIndex -> { min, max, entries: [] }
	for (var i = 0; i < entries.length; i++) {
		var e = entries[i];
		var pitches = e.concertPitches;
		if (!pitches || pitches.length === 0) continue;
		if (!perStaff[e.staffIndex])
			perStaff[e.staffIndex] = { min: Infinity, max: -Infinity, entries: [] };
		var rec = perStaff[e.staffIndex];
		for (var p = 0; p < pitches.length; p++) {
			if (pitches[p] < rec.min) rec.min = pitches[p];
			if (pitches[p] > rec.max) rec.max = pitches[p];
		}
		rec.entries.push(e);
	}
	var staffKeys = Object.keys(perStaff);
	if (staffKeys.length < 2) return null; // single-staff slot — leave alone

	// Overall extremes
	var globalMin = Infinity, globalMax = -Infinity;
	for (var k = 0; k < staffKeys.length; k++) {
		var r = perStaff[staffKeys[k]];
		if (r.min < globalMin) globalMin = r.min;
		if (r.max > globalMax) globalMax = r.max;
	}

	var unified;
	if (globalMax <= midline) {
		// All at or below the midline -> unified up
		unified = 'up';
	} else if (globalMin >= midline) {
		// All at or above -> unified down
		unified = 'down';
	} else if ((globalMax - midline) > 3 && (midline - globalMin) > 3) {
		// Straddling the midline by more than a 5th on each side -> outward.
		// "Outward" = each staff points its stems AWAY from the midline that
		// sits between the staves.  Upper-staff notes (avg above midline)
		// get stems UP (away, up); lower-staff notes (avg below midline)
		// get stems DOWN.
		var out = {};
		for (var s = 0; s < staffKeys.length; s++) {
			var rec2 = perStaff[staffKeys[s]];
			var avg = (rec2.min + rec2.max) / 2;
			var dir = (avg >= midline) ? 'up' : 'down';
			for (var ei = 0; ei < rec2.entries.length; ei++) {
				out[rec2.entries[ei].key] = dir;
			}
		}
		return out;
	} else {
		// Mixed but close — default piano convention: unified down.
		unified = 'down';
	}

	var result = {};
	for (var i2 = 0; i2 < entries.length; i2++) {
		result[entries[i2].key] = unified;
	}
	return result;
}

// Find the stem RelativeElement in an unbeamed absolute element.
// Returns null if not found or if the abselem is beamed (beam stems are
// handled separately).
function findStem(abselem) {
	if (!abselem || !abselem.children) return null;
	if (abselem.beam) return null; // beamed — beam.js will create the stem later
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
// We compute stemHeight from the current stem so we don't drift across
// successive flips.
function rebuildStem(abselem, stem, newDir) {
	if (!abselem || !abselem.abcelem) return;
	var minp = abselem.abcelem.minpitch;
	var maxp = abselem.abcelem.maxpitch;
	if (minp === undefined || maxp === undefined) return;
	// Recover stemHeight from the current stem.  The current direction is
	// encoded in stem.linewidth: negative -> up, positive -> down (per
	// addNoteToAbcElement: width = (dir === 'down') ? 1 : -1).  Pitch /
	// pitch2 ordering is NOT a reliable signal because in both directions
	// pitch2 (top of stem) > pitch (bottom of stem).
	var currentDir = (stem.linewidth !== undefined && stem.linewidth < 0) ? 'up' : 'down';
	if (currentDir === newDir) return;

	var stemHeight;
	if (currentDir === 'up') {
		// stem.pitch2 (top) = maxpitch + stemHeight
		stemHeight = stem.pitch2 - maxp;
	} else {
		// stem.pitch (bottom) = minpitch - stemHeight
		// Note: this can be off if abstract-engraver clamped p1 to 6.
		// Use distance from pitch2 (which is maxp - 1/3) as a fallback.
		stemHeight = minp - stem.pitch;
		if (stemHeight < 1) {
			// p1 was clamped; recover from total stem extent
			stemHeight = (stem.pitch2 + 1 / 3) - stem.pitch;
		}
	}
	// Sanity: never let stemHeight collapse to something tiny because of
	// rounding (the original is 7 for default voiceScale=1, less if scaled).
	if (!isFinite(stemHeight) || stemHeight < 1) stemHeight = 7;

	var headW = (abselem.heads && abselem.heads.length > 0) ? abselem.heads[0].w : 0;
	if (newDir === 'up') {
		stem.pitch = minp + 1 / 3;
		stem.pitch2 = maxp + stemHeight;
		stem.dx = headW;
		stem.linewidth = -1;
		stem.bottom = stem.pitch - 1;
	} else {
		stem.pitch = minp - stemHeight;
		stem.pitch2 = maxp - 1 / 3;
		stem.dx = 0;
		stem.linewidth = 1;
		stem.bottom = stem.pitch - 1;
	}
	// Update top/bottom on the RelativeElement to match the new pitch range
	stem.top = Math.max(stem.pitch, stem.pitch2);
	stem.bottom = Math.min(stem.pitch, stem.pitch2);

	// Update each notehead's stemDir
	if (abselem.heads) {
		for (var h = 0; h < abselem.heads.length; h++) {
			abselem.heads[h].stemDir = newDir;
		}
	}
}

// Apply a direction to a beamed note.  For beams, the stem RelativeElement
// is constructed downstream by layout/beam.js createStems(), which reads
// beam.stemsUp.  So if every member of the beam is in slots that demand a
// single unified direction matching that beam's stemsUp, no action needed.
// If a beam straddles slots with conflicting demands, the design says: do
// nothing per-note and let the beam stay as-is (cross-staff beams are out
// of scope, and changing only some members of a beam would break it).
//
// Returns true if the beam's stemsUp was changed, false otherwise.
function rebuildBeamIfUnanimous(beam, perEntryDir) {
	if (!beam || !beam.elems) return false;
	var desired = null;
	for (var i = 0; i < beam.elems.length; i++) {
		var ae = beam.elems[i];
		var key = perEntryDir.get(ae);
		if (!key) {
			// Some members aren't in cross-staff slots — leave the beam alone.
			return false;
		}
		if (desired === null) desired = key;
		else if (desired !== key) {
			// Conflicting demands within the beam — out of scope.
			return false;
		}
	}
	if (!desired) return false;
	var newStemsUp = (desired === 'up');
	if (beam.stemsUp === newStemsUp) return false;
	beam.stemsUp = newStemsUp;
	beam.forceup = newStemsUp;
	beam.forcedown = !newStemsUp;
	// Rewrite each member head's stemDir so it matches.
	for (var j = 0; j < beam.elems.length; j++) {
		var el = beam.elems[j];
		if (!el.heads) continue;
		for (var h = 0; h < el.heads.length; h++) {
			el.heads[h].stemDir = desired;
		}
	}
	return true;
}

function unifyOneLine(group, staffGroup) {
	if (!group) return;
	var timeSlot = group.timeSlot;
	var midline = MIDLINE;

	// Pass 1: per slot, gather entries, compute concert pitches,
	// decide a direction map per entry.  Collect per-abselem desired
	// direction so we can later handle beams consistently.
	var perAbselemDir = new Map(); // abselem -> 'up'|'down'

	var keys = Object.keys(timeSlot);
	for (var ki = 0; ki < keys.length; ki++) {
		var raw = timeSlot[keys[ki]];
		if (!raw || raw.length < 2) continue; // need 2+ notes to unify

		// Build slot entries: only include note abselems with heads.
		var entries = [];
		for (var ri = 0; ri < raw.length; ri++) {
			var rec = raw[ri];
			var ae = rec.abselem;
			if (!ae || !ae.heads || ae.heads.length === 0) continue;
			if (ae.abcelem && ae.abcelem.rest) continue;
			var pitches = [];
			for (var hi = 0; hi < ae.heads.length; hi++) {
				var head = ae.heads[hi];
				if (head && head.pitch !== undefined) {
					pitches.push(concertPitch(rec.voice, head.pitch));
				}
			}
			if (pitches.length === 0) continue;
			entries.push({
				key: rec.voiceIndex + ':' + ki + ':' + ri,
				voiceIndex: rec.voiceIndex,
				voice: rec.voice,
				staffIndex: rec.staffIndex,
				abselem: ae,
				concertPitches: pitches
			});
		}
		if (entries.length < 2) continue;
		// Need notes in at least two different staves to make this a
		// cross-staff slot.
		var staffIndices = {};
		for (var ei = 0; ei < entries.length; ei++) staffIndices[entries[ei].staffIndex] = true;
		if (Object.keys(staffIndices).length < 2) continue;

		var directions = decideDirections(entries, midline);
		if (!directions) continue;
		for (var ei2 = 0; ei2 < entries.length; ei2++) {
			var entry = entries[ei2];
			var d = directions[entry.key];
			if (!d) continue;
			perAbselemDir.set(entry.abselem, d);
		}
	}

	// Pass 2: apply to unbeamed stems immediately.  Collect beams to
	// rewrite in one shot to avoid re-processing.
	var beamsSeen = new Set();
	perAbselemDir.forEach(function (dir, abselem) {
		if (abselem.beam) {
			beamsSeen.add(abselem.beam);
			return;
		}
		var stem = findStem(abselem);
		if (!stem) return; // no stem (e.g. whole note) — nothing to flip
		rebuildStem(abselem, stem, dir);
	});

	// Pass 3: beams — only flip if every member agrees.  Cross-staff
	// beams or beams whose members aren't all in cross-staff slots are
	// left alone (they're out of scope per the design).
	beamsSeen.forEach(function (beam) {
		rebuildBeamIfUnanimous(beam, perAbselemDir);
	});
}

function unifyGrandStaffStems(abcLines) {
	var groups = toTimeAndGrandStaffBased(abcLines);
	for (var i = 0; i < abcLines.length; i++) {
		var line = abcLines[i];
		if (!line || !line.staffGroup) continue;
		var group = groups[i];
		if (!group) continue;
		unifyOneLine(group, line.staffGroup);
	}
}

module.exports = unifyGrandStaffStems;
