import subprocess

# Create a new branch for updating the graphify tool
def update_graphify():
    subprocess.run(['git', 'checkout', '-b', 'update-graphify'])