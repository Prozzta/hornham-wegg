# THREAD-VIEW build notes

- The accepted Windows micro-scale run (`thread-view-micro-13971dd9.log`) has
  roughly 16 ms phase/whole maxima while its idle control is 15.6 ms. That is
  the Windows timer-resolution floor, not measurable THREAD-VIEW main-loop
  load; interpret the 84 ms ceiling against that baseline.
