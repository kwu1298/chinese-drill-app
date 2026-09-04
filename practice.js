/* Shared by the phone and compiled into the Mac app. No DOM or AppKit. */
var Practice = {
  start: function (cards) {
    return cards.map(function (c) { return Object.assign({}, c, {practice: false}); });
  },
  // Replace an unattempted slot, never extend the promised session. One
  // intervening item is required. Retries never schedule or breed retries.
  repair: function (queue, index, correct, assisted) {
    var card = queue[index];
    if (card.practice || (correct && !assisted) || index + 2 >= queue.length) return false;
    var retry = Object.assign({}, card, {practice: true, first: false, teach: ''});
    if (card.context && card.dir === 'hz2py') {
      retry.prompt = card.context.sentence;
      retry.transfer = true;
    }
    queue.splice(index + 2, 0, retry);
    queue.pop();
    return true;
  },
  // A final context check uses an existing slot. It is practice, not another
  // spaced review of something just seen in this session.
  contextFinish: function (queue) {
    if (queue.length < 4) return;
    for (var i = 0; i < queue.length - 2; i++) {
      var c = queue[i];
      if (c.dir === 'hz2py' && c.context) {
        queue[queue.length - 1] = Object.assign({}, c, {
          prompt: c.context.sentence, practice: true, transfer: true, first: false, teach: ''
        });
        return;
      }
    }
  }
};
if (typeof module !== 'undefined') module.exports = Practice;
