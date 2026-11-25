const form = document.getElementById('prediction-form')
const feedback = document.getElementById('prediction-feedback')
const followup = document.getElementById('followup-exercise')
const nextExperiments = Array.from(followup.querySelectorAll('[data-followup]'))

form.addEventListener('submit', (event) => {
  event.preventDefault()
  const answer = new FormData(form).get('prediction')
  const expected = form.dataset.expected
  if (typeof answer !== 'string' || !expected) return

  const correct = answer === expected
  const leftWrong = answer[0] !== expected[0]
  const nextId = correct ? 'alias' : leftWrong ? 'isolate' : 'replace'
  feedback.textContent = correct
    ? '预测正确。只有左侧会改变原列表。'
    : leftWrong
      ? '左侧会改变原列表，因为两个外层列表共享第一个内层列表。'
      : '右侧只替换了副本里的元素，原列表没有变化。'

  document.querySelectorAll('[data-variant-result]').forEach((details) => { details.open = true })
  nextExperiments.forEach((item) => {
    item.hidden = item.dataset.followup !== nextId
    item.querySelector('details').open = false
  })
  followup.hidden = false
})

form.hidden = false
