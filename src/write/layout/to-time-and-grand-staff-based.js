// Build a per-line, time-keyed map of note AbsoluteElements that COLLAPSES
// all staves in a brace/bracket-grouped staff group into one shared timeslot
// dictionary.  Sibling of to-time-and-staff-based.js, which keeps one map
// per staff.  This module is used by the cross-staff stem-direction unifier
// (see unify-grand-staff-stems.js) — it needs both staves' notes that share
// a time bucket in order to compute a single holistic stem direction across
// the grand staff.
//
// Returns an array (parallel to abcLines).  Each element is either:
//   - null, when the line's staffGroup has no brace/bracket (i.e. it is not
//     a grand staff and stem unification does not apply), or
//   - { timeSlot, staves }, where timeSlot is keyed by 'T' + Math.round(time*1000)
//     and each entry is an array of { voiceIndex, voice, abselem } records
//     from across all staves of the brace group, and `staves` is the staffs
//     array (so callers can read top/bottom/clefMid as needed).
//
// Single-voice / non-grand-staff lines yield null so callers can early-out and
// preserve byte-identical rendering.

function toTimeAndGrandStaffBased(abcLines) {
	var results = [];
	for (var lin = 0; lin < abcLines.length; lin++) {
		var line = abcLines[lin];
		var staffGroup = line && line.staffGroup;
		if (!staffGroup || !staffGroup.staffs || staffGroup.staffs.length < 2) {
			results.push(null);
			continue;
		}
		// Only collapse if this is a real grand-staff group (brace OR bracket).
		// Non-grouped multi-staff systems (independent staves) should not have
		// their stems unified.
		if (!staffGroup.brace && !staffGroup.bracket) {
			results.push(null);
			continue;
		}
		var timeSlot = {};
		for (var s = 0; s < staffGroup.staffs.length; s++) {
			var staff = staffGroup.staffs[s];
			for (var i = 0; i < staff.voices.length; i++) {
				var voiceIndex = staff.voices[i];
				var voice = staffGroup.voices[voiceIndex];
				if (!voice || !voice.children) continue;
				var time = 0;
				for (var k = 0; k < voice.children.length; k++) {
					var abselem = voice.children[k];
					if (!abselem || !abselem.abcelem) continue;
					if (abselem.abcelem.el_type !== 'note') continue;
					var index = 'T' + Math.round(time * 1000);
					if (!timeSlot[index]) timeSlot[index] = [];
					timeSlot[index].push({
						voiceIndex: voiceIndex,
						voice: voice,
						abselem: abselem,
						staffIndex: s
					});
					time += abselem.duration || 0;
				}
			}
		}
		results.push({ timeSlot: timeSlot, staves: staffGroup.staffs });
	}
	return results;
}

module.exports = toTimeAndGrandStaffBased;
