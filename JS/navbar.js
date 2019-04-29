const topPoint = window.scrollY;
const navbar = document.querySelector('nav');
const words = document.querySelectorAll('nav a');


function showNavbar(e) {
  if (window.scrollY > 90) {
    words.forEach(word => {
      word.classList.add('changeText');
    });
    navbar.classList.add('changeBackground');
  } else {
    words.forEach(word => {
      word.classList.remove('changeText');
    });
    navbar.classList.remove('changeBackground');
  }
}


window.addEventListener('scroll', showNavbar)
console.log(window)
