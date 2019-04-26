const cards = document.querySelectorAll('.my-card');

function cardOpen(e) {
  console.dir(this);
  this.children[1].classList.toggle('openCard')
  this.children[0].classList.toggle('closeImg')
  const paragraph1 = `h2<p class="card-text">This is a longer card with supporting text below as a natural lead-in to additional content. Lorem ipsum dolor sit amet, consectetuer adipiscing elit. Integer tempor. Sed ut perspiciatis unde omnis iste natus error sit voluptatem accusantium doloremque laudantium, totam rem aperiam.</p>`
  const par1 = `<p class="card-text">This is a longer card with supporting text below as a natural lead-in to additional content. Lorem ipsum dolor sit amet, consectetuer adipiscing elit.</p>`
  if (this.children[1].innerHTML == paragraph1) {
    this.children[1].innerHTML = par1;
  } else {
    setTimeout(this.children[1].innerHTML = paragraph1, 3000)
  }

}

cards.forEach(card => card.addEventListener('click', cardOpen));
