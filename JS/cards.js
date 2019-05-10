function init() {
  const cards = document.querySelectorAll('.my-card');
  let query = window.matchMedia('(min-width: 600px)');
  const paragraphs = document.querySelectorAll('.card-text')

  function cardOpen(e) {
    if(query.matches) {
          console.log('yo')
      //flex open
      this.children[1].classList.toggle('openCard')
      //add text
      const extraText = document.createTextNode(this.children[1].children[1].dataset.extra)
      if(this.children[1].classList.contains('openCard')) {
        this.children[1].children[1].appendChild(extraText)
        this.children[1].children[2].remove()
      } else {
        this.children[1].children[1].lastChild.remove()
        //creating a read more
        const read = document.createTextNode("click for more...")
        const el = document.createElement('a')
        el.className = "read-more"
        el.appendChild(read)
        this.children[1].appendChild(el)
      }
    }else {
      this.children[1].classList.toggle('openCardSM')
      //add text
      const extraText = document.createTextNode(this.children[1].children[1].dataset.extra)
      if(this.children[1].classList.contains('openCardSM')) {
        this.children[1].children[1].appendChild(extraText)
        this.children[1].children[2].remove()
      } else {
        this.children[1].children[1].lastChild.remove()
        //creating a read more
        const read = document.createTextNode("click for more...")
        const el = document.createElement('a')
        el.className = "read-more"
        el.appendChild(read)
        this.children[1].appendChild(el)
      }
    }
  }

  cards.forEach(card => card.addEventListener('click', cardOpen));
}

window.addEventListener('DOMContentLoaded', init)
window.addEventListener('resize', init)
