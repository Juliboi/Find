const topPoint = window.scrollY;
const navbar = document.querySelector('nav');
const words = document.querySelectorAll('.navbar a');
const dropdown = document.querySelector('.dd-menu')

function showNavbar(e) {
  if (window.scrollY > 90) {
    words.forEach(word => {
      word.classList.add('changeText');
    });
    navbar.classList.add('changeBackground');
    dropdown.classList.add('changeBackground');
  } else {
    words.forEach(word => {
      word.classList.remove('changeText');
    });
    navbar.classList.remove('changeBackground');
    dropdown.classList.remove('changeBackground');
  }
}


window.addEventListener('scroll', showNavbar);
window.addEventListener('DOMContentLoaded', showNavbar);
//console.log(window)
