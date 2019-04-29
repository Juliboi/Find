//CARD TEXT UPDATE

function init() {
  const cards = document.querySelectorAll('.my-card');
  let query = window.matchMedia('(min-width: 600px)');

  if(query.matches) {
    function cardOpen(e) {
      this.children[1].classList.toggle('openCard')
      const paragraph1 = `<h5 class="card-title py-3">About us</h5><p class="card-text">This is a longer card with supporting text below as a natural lead-in to additional content. Lorem ipsum dolor sit amet, consectetuer adipiscing elit. Integer tempor. Sed ut perspiciatis unde omnis iste natus error sit voluptatem accusantium doloremque laudantium. Lorem ipsum dolor sit amet, consectetuer adipiscing elit. Integer tempor. Sed ut perspiciatis unde omnis iste natus error sit voluptatem accusantium doloremque laudantium.</p>`
      const par1 = `<h5 class="card-title">About us</h5><p class="card-text">This is a longer card with supporting text below as a natural lead-in to additional content. Lorem ipsum dolor sit amet, consectetuer adipiscing elit.</p>`
      if (this.children[1].innerHTML == paragraph1) {
        this.children[1].innerHTML = par1;
      } else {
        this.children[1].innerHTML = paragraph1;
      }
    }

    cards.forEach(card => card.addEventListener('click', cardOpen));

  }else {
    return
  }
}

function reset() {
  const cards = document.querySelectorAll('.my-card');


}

window.addEventListener('DOMContentLoaded', init)
window.addEventListener('resize', reset);
