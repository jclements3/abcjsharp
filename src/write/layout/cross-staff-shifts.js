// Cross-staff notehead collision fix.
//
// The intra-chord printer_shift logic in AbstractEngraver.addNoteToAbcElement
// only considers adjacency between pitches WITHIN a single chord element.  It
// does not see across voices/staves.  When a grand-staff system has two voices
// whose noteheads happen to land at the same x and at adjacent concert pitches
// (e.g. treble C4 + bass B3), the noteheads visually collide.
//
// This pass runs after per-voice layout (so absolute elements have x positions)
// but before the staff group's height is set, finds cross-voice notehead pairs
// at the same x with adjacent concert pitches, and offsets the lower-pitched
// notehead by ~one notehead width so the two are visually distinguishable.
//
// "Concert pitch" is computed as `verticalPos + clef.verticalPos` (mid).  The
// clef.verticalPos for each voice is recorded on the voice element when the
// staff is created (see abstract-engraver.js).  Using concert pitch makes the
// adjacency test invariant to inter-staff spacing — it works whether the
// consumer uses a default gap, a compressed 11-line continuous system, or any
// other layout.

var X_TOLERANCE = 0.5; // pixels — notes are at the "same x" if within this.

function getConcertPitch(voice, verticalPos) {
	// clefMid is stored on the voice when it is created in createABCStaff.  It
	// is the clef's `verticalPos` field, which represents the absolute pitch
	// that sits in the middle of the staff.  Concert pitch is then the
	// notehead's verticalPos (= absPitch - clefMid) plus clefMid = absPitch.
	var mid = (voice.clefMid !== undefined) ? voice.clefMid : 0;
	return verticalPos + mid;
}

function collectNoteheads(staffGroup) {
	// Returns a flat list of { voice, abselem, notehead, pitchelem, concertPitch, dir }
	// across all voices in the staffGroup.
	var entries = [];
	if (!staffGroup || !staffGroup.voices) return entries;
	for (var vi = 0; vi < staffGroup.voices.length; vi++) {
		var voice = staffGroup.voices[vi];
		if (!voice || !voice.children) continue;
		for (var ci = 0; ci < voice.children.length; ci++) {
			var abselem = voice.children[ci];
			if (!abselem || !abselem.heads || abselem.heads.length === 0) continue;
			// abselem.abcelem.pitches is the array of pitch records.  Each head
			// has a `pitch` equal to its pitchelem's verticalPos.
			var pitches = (abselem.abcelem && abselem.abcelem.pitches) ? abselem.abcelem.pitches : null;
			for (var hi = 0; hi < abselem.heads.length; hi++) {
				var head = abselem.heads[hi];
				if (!head || head.pitch === undefined) continue;
				// Find the matching pitchelem (the one whose verticalPos matches the head).
				var pitchelem = null;
				if (pitches) {
					for (var pi = 0; pi < pitches.length; pi++) {
						if (pitches[pi].verticalPos === head.pitch) {
							pitchelem = pitches[pi];
							break;
						}
					}
				}
				entries.push({
					voiceIndex: vi,
					voice: voice,
					abselem: abselem,
					notehead: head,
					pitchelem: pitchelem,
					concertPitch: getConcertPitch(voice, head.pitch),
					dir: head.stemDir
				});
			}
		}
	}
	return entries;
}

function bucketByX(entries) {
	// Group entries into buckets where they share the same x (within tolerance).
	// Returns an array of arrays.
	var sorted = entries.slice().sort(function (a, b) {
		return (a.abselem.x || 0) - (b.abselem.x || 0);
	});
	var buckets = [];
	var current = [];
	var currentX = null;
	for (var i = 0; i < sorted.length; i++) {
		var x = sorted[i].abselem.x || 0;
		if (currentX === null || Math.abs(x - currentX) <= X_TOLERANCE) {
			current.push(sorted[i]);
			if (currentX === null) currentX = x;
		} else {
			if (current.length > 1) buckets.push(current);
			current = [sorted[i]];
			currentX = x;
		}
	}
	if (current.length > 1) buckets.push(current);
	return buckets;
}

function shiftNotehead(entry) {
	// Set the printer_shift flag for bookkeeping, and adjust the notehead's
	// dx and x by ~one notehead width in the direction appropriate for its
	// stem direction (matches the convention used in create-note-head.js).
	if (entry.pitchelem) entry.pitchelem.printer_shift = "different";
	var head = entry.notehead;
	// realWidth is set by RelativeElement (it's the same as w for noteheads).
	var w = (head.realWidth || head.w || 0);
	if (!w) return;
	// Match create-note-head's convention exactly:
	//   dir==="down" -> shift left by w
	//   dir==="up"   -> shift right by w
	// `head.stemDir` is set by createNoteHead.
	var delta = (entry.dir === "down") ? -w : w;
	head.dx += delta;
	if (head.x !== undefined && head.x !== 0) head.x += delta;
}

function applyCrossStaffShifts(staffGroup) {
	if (!staffGroup || !staffGroup.voices || staffGroup.voices.length < 2) return;
	// Only meaningful for staff groups with more than one staff.
	if (!staffGroup.staffs || staffGroup.staffs.length < 2) return;

	var entries = collectNoteheads(staffGroup);
	var buckets = bucketByX(entries);

	for (var b = 0; b < buckets.length; b++) {
		var bucket = buckets[b];
		// Track which entries have already been shifted to avoid double-shifting
		// when more than two voices coincide.
		var shifted = {}; // keyed by entry index in bucket
		for (var i = 0; i < bucket.length; i++) {
			for (var j = i + 1; j < bucket.length; j++) {
				var a = bucket[i];
				var c = bucket[j];
				// Only compare cross-voice (and cross-staff) pairs.
				if (a.voiceIndex === c.voiceIndex) continue;
				if (a.voice.staff === c.voice.staff) continue;
				var diff = Math.abs(a.concertPitch - c.concertPitch);
				// Adjacency at one diatonic step.  Same pitch (diff===0) is left
				// alone because the user expectation is that identical pitches in
				// different voices superimpose.
				if (diff !== 1) continue;
				// Pick the LOWER-pitched entry to shift (per the documented
				// convention).  If one has already been shifted in this bucket,
				// shift the other.
				var lower = (a.concertPitch < c.concertPitch) ? a : c;
				var lowerIdx = (lower === a) ? i : j;
				var higherIdx = (lower === a) ? j : i;
				if (shifted[lowerIdx]) {
					if (!shifted[higherIdx]) {
						shiftNotehead(bucket[higherIdx]);
						shifted[higherIdx] = true;
					}
				} else {
					shiftNotehead(lower);
					shifted[lowerIdx] = true;
				}
			}
		}
	}
}

module.exports = applyCrossStaffShifts;
